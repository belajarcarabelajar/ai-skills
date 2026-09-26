// scripts/plan-mark-done.test.mjs
//
// Guards for the tick-applying command. This command is the ONLY thing in the
// repository that rewrites a plan file, so every test here is written as a
// question about bytes: which lines changed, and which must not have.
//
// Why a diff and not a spot check: the acceptance criterion is that the other
// task's lines are BYTE-IDENTICAL afterwards. Asserting one line survived proves
// nothing about the twelve lines nobody looked at, so `ticks only the step lines
// of the named task` computes the full line-by-line diff and asserts that the
// changed set is exactly the expected set. A new heuristic that quietly starts
// ticking the section-8 backlog or a `- [ ]` mentioned mid-sentence shows up as a
// line in that diff, not as a subtle later surprise in a 271-file publish.
//
// Every fixture is built inline under the system temp dir. Nothing here reads or
// writes the real plans directory, the Obsidian vault, or git.
//
// The command is driven as a SUBPROCESS for the same reason plan-publish.test.mjs
// does it: the contract under test is an exit code plus a file on disk, and an
// in-process call cannot prove the process exits 2 on a bad flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, statSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Namespace import on purpose: a named import of a symbol that does not exist is
// a module LINK error that aborts the file before a single test runs, so every
// failure below would be reported as "the file could not be loaded" instead of
// as the assertion that actually failed.
import * as md from './plan-mark-done.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'plan-mark-done.mjs');

// ---------- fixtures ----------

// A two-task plan. Built as an array of lines so a test can name the index it
// expects to change, which is what makes the diff assertions readable.
//
// The lines that must NEVER be touched are deliberate, and each one is a
// different way this could go wrong if the "which lines are steps" rule were
// "contains a checkbox":
//   - a `- [ ]` in section 8      → outside every task section
//   - a `- [ ]` mid-sentence      → not a list item at all
//   - a `- [ ]` inside a fence     → an example, not an instruction
//   - an already-ticked `[x]`      → ticking is a no-op, not a reformat
//   - T2's step lines              → a different task
const FIXTURE_LINES = [
  '---',
  'schema: ultra-plan/v1',
  'plan_id: 2099-01-01-fixture',
  'status: Draft',
  'tasks:',
  '  - id: T1',
  '    depends_on: []',
  '  - id: T2',
  '    depends_on: [T1]',
  '---',
  '',
  '# Fixture plan for plan-mark-done',
  '',
  'Prose: this sentence mentions - [ ] a box mid-line and must survive untouched.',
  '',
  '## 4. Tasks',
  '',
  '### Task T1: the first task',
  '',
  '- [ ] **Step 1 — do the thing:** run it | expect: exit 0',
  '- [x] **Step 2 — already done:** nothing to see here',
  '  - [ ] a nested preconditions line, which is still a step',
  '```bash',
  'bun test   # - [ ] inside a fence is prose, not a step',
  '```',
  '',
  '### Task T2: the second task',
  '',
  '- [ ] **Step 1 — T2 line one:** must stay byte-identical',
  '- [ ] **Step 2 — T2 line two:** must stay byte-identical',
  '',
  '## 5. Verification Matrix',
  '',
  '| Check | Status |',
  '|---|---|',
  '| something | Pending |',
  '',
  '## 8. Debt Sweep',
  '',
  '- [ ] a backlog item in section 8 belongs to no task at all',
  '',
];

const L = (n) => FIXTURE_LINES[n];

// Runner log fixtures. The status strings are copied from ultra-plan-runner.mjs
// (`  ${id}: ${status}` at lines 365-403) rather than invented, because this
// command's whole job is to parse that output. If the runner ever changes a
// status token, these fixtures must change with it.
const PLAN_HEADER = [
  'Plan: 2099-01-01-fixture  schema=ultra-plan/v1  status=Draft  tasks=2',
  'Validation: OK',
  '',
];
const EMPTY_LEDGER = ['Error Ledger: (empty — no failures)', ''];
const LEDGER_TABLE = [
  '## Error Ledger',
  '| Task | Step | Classification | Exit | Root cause | Retry used | Status |',
  '|---|---|---|---|---|---|---|',
  '| T1 | 2 | code | 1 | step command exit mismatch | 0/1 | `FAILED-BLOCKING` |',
  '',
];

const logLines = (statusLines, ledger = EMPTY_LEDGER) => [...PLAN_HEADER, ...statusLines, '', ...ledger].join('\n');

const LOG_T1_PASSED = logLines(['  T1: PASSED']);
const LOG_T1_SKIPPED = logLines(['  T1: SKIPPED-IDEMPOTENT (skip_if exit 0)']);
const LOG_T1_READY = logLines(['Dry-run DAG (topological order); pass --execute to run:', '  T1: READY (dry-run)']);
const LOG_T1_NEEDS_AGENT = logLines([
  'Executing DAG (topological order):',
  '  T1: NEEDS-AGENT (no frontmatter run[]; agent executes prose steps)',
]);
const LOG_T1_FAILED = logLines(
  ['Executing DAG (topological order):', '  T1: FAILED-BLOCKING at step 2 (exit 1)'],
  LEDGER_TABLE,
);
const LOG_MIXED = logLines([
  'Executing DAG (topological order):',
  '  T1: PASSED',
  '  T2: NEEDS-AGENT (no frontmatter run[]; agent executes prose steps)',
]);
const LOG_STRANGER = logLines([
  'Executing DAG (topological order):',
  '  T1: PASSED',
  '  T9: PASSED',
]);

// ---------- harness ----------

function fixture(tag, { lines = FIXTURE_LINES, eol = '\n' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), `plan-mark-done-${tag}-`));
  const plan = path.join(dir, 'plan.md');
  // No extra trailing eol: FIXTURE_LINES already ends with an empty entry, so
  // the file ends in exactly one newline and `split(eol)` reproduces the array
  // element-for-element. That is what lets the diff assertions use plain indices.
  writeFileSync(plan, lines.join(eol), 'utf8');
  return { dir, plan };
}

function logFile(text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-mark-done-log-'));
  const p = path.join(dir, 'run.log');
  writeFileSync(p, text, 'utf8');
  return { dir, path: p };
}

function run(args, { input } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Run the CLI with a log, then return the plan's lines.
function runWithLog(f, logText) {
  const l = logFile(logText);
  try {
    const r = run([f.plan, '--from', l.path]);
    return { r, lines: readFileSync(f.plan, 'utf8').split('\n') };
  } finally {
    rmSync(l.dir, { recursive: true, force: true });
  }
}

// The changed-line set, as [index, before, after] triples. Comparing this to an
// exact expected list is what makes "only these lines changed" a real assertion
// rather than a spot check.
function diff(before, after) {
  assert.equal(after.length, before.length, 'line count must not change');
  const out = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) out.push([i, before[i], after[i]]);
  return out;
}

const ticked = (s) => s.replace('[ ]', '[x]');

// ---------- the core contract ----------

test('ticks only the step lines of the named task', () => {
  const f = fixture('only-named');
  const r = runWithLog(f, LOG_T1_PASSED);
  assert.equal(r.r.code, 0, `stdout: ${r.r.stdout}\nstderr: ${r.r.stderr}`);

  // The whole assertion: exactly these two lines, and no others anywhere.
  assert.deepEqual(
    diff(FIXTURE_LINES, r.lines),
    [
      [19, L(19), ticked(L(19))],
      [21, L(21), ticked(L(21))],
    ],
    'only T1\'s unticked step lines may change, and nothing else in the file',
  );

  // Spelled out as well, so a failure names the hazard rather than an index.
  const t2 = r.lines.slice(27, 30);
  assert.deepEqual(t2, FIXTURE_LINES.slice(27, 30), "T2's step lines must be byte-identical afterwards");
  assert.match(r.lines[23], /- \[ \] inside a fence/, 'a checkbox inside a code fence is not a step');

  rmSync(f.dir, { recursive: true, force: true });
});

test('never touches a non-step line', () => {
  const f = fixture('non-step');
  const r = runWithLog(f, LOG_T1_PASSED);
  assert.equal(r.r.code, 0, r.r.stderr);

  // The four hazards, named by what they are rather than by their index.
  assert.equal(r.lines[13], L(13), 'a - [ ] inside a prose sentence must survive');
  assert.equal(r.lines[23], L(23), 'a - [ ] inside a fenced code block must survive');
  assert.equal(r.lines[38], L(38), 'a - [ ] in section 8 is not a step of any task');
  assert.equal(r.lines[32], L(32), 'the Verification Matrix is not a checklist');
  assert.equal(r.lines[20], L(20), 'an already-ticked line must not be rewritten');

  rmSync(f.dir, { recursive: true, force: true });
});

// ---------- refusals ----------

test('refuses an unknown task id', () => {
  const f = fixture('unknown-id');
  const before = readFileSync(f.plan, 'utf8');

  const r = run([f.plan, '--task', 'T9']);
  assert.notEqual(r.code, 0, 'an unknown task id must not exit 0');
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /T9/, 'the refusal must name the id that was asked for');
  assert.equal(readFileSync(f.plan, 'utf8'), before, 'a refused id must not touch the file');

  rmSync(f.dir, { recursive: true, force: true });
});

test('refuses a plan whose frontmatter declares no tasks to check against', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-mark-done-no-tasks-'));
  const plan = path.join(dir, 'plan.md');
  writeFileSync(plan, '---\nschema: ultra-plan/v1\nplan_id: x\n---\n\n## 4. Tasks\n\n### Task T1: x\n\n- [ ] a step\n', 'utf8');

  const r = run([plan, '--task', 'T1']);
  assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /tasks\[\]\.id/, 'the refusal must say there is no id list to check membership against');

  rmSync(dir, { recursive: true, force: true });
});

// ---------- no-op ----------

test('is a no-op when the steps are already ticked', () => {
  const pre = FIXTURE_LINES.map((l) => l.replace('[ ]', '[x]'));
  const f = fixture('noop', { lines: pre });
  const before = readFileSync(f.plan, 'utf8');
  const mtime = statSync(f.plan).mtimeMs;

  const r = runWithLog(f, LOG_T1_PASSED);
  assert.equal(r.r.code, 0, `stdout: ${r.r.stdout}\nstderr: ${r.r.stderr}`);
  assert.equal(readFileSync(f.plan, 'utf8'), before, 'already-ticked steps must be byte-identical');
  assert.equal(statSync(f.plan).mtimeMs, mtime, 'a no-op must not rewrite the file at all');
  assert.match(r.r.stdout, /T1/, 'the no-op still names the task it considered');
  assert.match(r.r.stdout, /no-op/i, 'the output must say it was a no-op, not a silent success');

  rmSync(f.dir, { recursive: true, force: true });
});

test('leaves an already-ticked line byte-identical rather than reformatting it', () => {
  const lines = FIXTURE_LINES.slice();
  lines[20] = '- [X] **Step 2 — ticked in the other case:** do not normalise the case';
  const f = fixture('upper-x', { lines });

  const r = runWithLog(f, LOG_T1_PASSED);
  assert.equal(r.r.code, 0, r.r.stderr);
  assert.equal(r.lines[20], lines[20], '[X] is already ticked; rewriting it to [x] is an edit nobody asked for');
  assert.deepEqual(
    diff(lines, r.lines),
    [[19, lines[19], ticked(lines[19])], [21, lines[21], ticked(lines[21])]],
    'only the two genuinely unticked lines may change',
  );

  rmSync(f.dir, { recursive: true, force: true });
});

// ---------- evidence vs assertion ----------

test('reports whether the tick came from evidence or from an assertion', () => {
  const fromLog = fixture('evidence');
  const a = runWithLog(fromLog, LOG_T1_PASSED);
  assert.equal(a.r.code, 0, a.r.stderr);
  assert.match(a.r.stdout, /evidence/i, 'an evidence tick must say so');
  assert.match(a.r.stdout, /PASSED/, 'an evidence tick must name the recorded status it trusted');
  assert.doesNotMatch(a.r.stdout, /asserted, no evidence/, 'an evidence tick must not be labelled an assertion');
  rmSync(fromLog.dir, { recursive: true, force: true });

  const asserted = fixture('asserted');
  const b = run([asserted.plan, '--task', 'T1']);
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stdout, /asserted, no evidence/i, 'an asserted tick must say it has no evidence behind it');
  assert.doesNotMatch(b.stdout, /evidence: /, 'an assertion must not be dressed up as a recorded status');
  // It did tick, and the glyph was a warning rather than a tick.
  assert.equal(readFileSync(asserted.plan, 'utf8').includes(ticked(L(19))), true);
  rmSync(asserted.dir, { recursive: true, force: true });
});

test('reads the runner log from stdin when --from is -', () => {
  const f = fixture('stdin');
  const r = run([f.plan, '--from', '-'], { input: LOG_T1_PASSED });
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /evidence/i);
  assert.deepEqual(
    diff(FIXTURE_LINES, readFileSync(f.plan, 'utf8').split('\n')),
    [[19, L(19), ticked(L(19))], [21, L(21), ticked(L(21))]],
  );
  rmSync(f.dir, { recursive: true, force: true });
});

test('accepts SKIPPED-IDEMPOTENT as a terminal success', () => {
  const f = fixture('skipped');
  const r = runWithLog(f, LOG_T1_SKIPPED);
  assert.equal(r.r.code, 0, r.r.stderr);
  assert.deepEqual(
    diff(FIXTURE_LINES, r.lines),
    [[19, L(19), ticked(L(19))], [21, L(21), ticked(L(21))]],
    'skip_if exit 0 means the work was already done, so the steps may be ticked',
  );
  rmSync(f.dir, { recursive: true, force: true });
});

// ---------- non-success statuses are not success ----------

test('does not tick a task the log records as NEEDS-AGENT', () => {
  const f = fixture('needs-agent');
  const r = runWithLog(f, LOG_T1_NEEDS_AGENT);
  assert.notEqual(r.r.code, 0, 'a task handed back to the agent is not a closed task');
  assert.deepEqual(diff(FIXTURE_LINES, r.lines), [], 'nothing may be written');
  assert.match(r.r.stdout + r.r.stderr, /NEEDS-AGENT/, 'the status that blocked the tick must be reported');
  rmSync(f.dir, { recursive: true, force: true });
});

test('does not treat a dry-run READY line as success', () => {
  const f = fixture('dry-run');
  const r = runWithLog(f, LOG_T1_READY);
  assert.notEqual(r.r.code, 0, 'READY (dry-run) means nothing ran at all');
  assert.deepEqual(diff(FIXTURE_LINES, r.lines), [], 'nothing may be written');
  assert.match(r.r.stdout + r.r.stderr, /READY/, 'the blocking status must be reported');
  rmSync(f.dir, { recursive: true, force: true });
});

test('does not tick a task the log records as FAILED and surfaces its Error Ledger row', () => {
  const f = fixture('failed');
  const r = runWithLog(f, LOG_T1_FAILED);
  assert.equal(r.r.code, 1, `stdout: ${r.r.stdout}\nstderr: ${r.r.stderr}`);
  assert.deepEqual(diff(FIXTURE_LINES, r.lines), [], 'a red step must not end up with a ticked box');
  const out = r.r.stdout + r.r.stderr;
  assert.match(out, /FAILED-BLOCKING/, 'the failure status must be reported');
  assert.match(
    out,
    /\|\s*T1\s*\|.*step command exit mismatch/i,
    "the runner's own Error Ledger row for the task must be surfaced verbatim",
  );
  rmSync(f.dir, { recursive: true, force: true });
});

// ---------- fail closed ----------

test('fails closed when the log names a task the plan does not have', () => {
  const f = fixture('stranger');
  const r = runWithLog(f, LOG_STRANGER);
  assert.equal(r.r.code, 1, `stdout: ${r.r.stdout}\nstderr: ${r.r.stderr}`);
  assert.match(r.r.stderr, /T9/, 'the refusal must name the id the log invented');
  // The real point of failing closed: T1 IS in the log and IS a real success,
  // and it still must not be written, because the log is not about this plan.
  assert.deepEqual(diff(FIXTURE_LINES, r.lines), [], 'a log that does not match the plan must write nothing at all');
  rmSync(f.dir, { recursive: true, force: true });
});

test('fails closed when the log contains no runner status lines', () => {
  const f = fixture('no-status');
  const r = runWithLog(f, 'this log is a stack trace, not a runner record\nnothing here resembles T1: PASSED\n');
  assert.equal(r.r.code, 1, `stdout: ${r.r.stdout}\nstderr: ${r.r.stderr}`);
  assert.deepEqual(diff(FIXTURE_LINES, r.lines), [], 'an unparseable log is not evidence');
  rmSync(f.dir, { recursive: true, force: true });
});

test('fails closed when the plan declares the task but the body has no section for it', () => {
  const lines = FIXTURE_LINES.filter((l) => !l.startsWith('### Task T1') && !l.startsWith('- [ ] **Step 1 — do the thing'));
  const f = fixture('no-section', { lines });
  const r = runWithLog(f, LOG_T1_PASSED);
  assert.equal(r.r.code, 1, `stdout: ${r.r.stdout}\nstderr: ${r.r.stderr}`);
  assert.match(r.r.stdout + r.r.stderr, /T1/, 'the id that has no section must be named');
  rmSync(f.dir, { recursive: true, force: true });
});

// ---------- reporting ----------

test('prints one line per task considered and a tally that adds up', () => {
  const f = fixture('tally');
  const r = runWithLog(f, LOG_MIXED);
  const out = r.r.stdout;
  assert.match(out, /^.*T1:.*ticked/m, 'T1 must have its own outcome line');
  assert.match(out, /^.*T2:.*NOT ticked/m, 'T2 must have its own outcome line');

  const m = /tally: (\d+) considered · (\d+) ticked · (\d+) no-op · (\d+) not-ticked/.exec(out);
  assert.ok(m, `the run must end in a parseable tally, got:\n${out}`);
  const [, total, tickedCount, noop, notTicked] = m.map(Number);
  assert.equal(total, tickedCount + noop + notTicked, 'the tally must add up');
  assert.equal(total, 2);
  assert.equal(tickedCount, 1);
  assert.equal(notTicked, 1);
  assert.notEqual(r.r.code, 0, 'a run that could not close every task it saw must not exit 0');
  rmSync(f.dir, { recursive: true, force: true });
});

// ---------- usage ----------

test('exits 2 on an unknown flag and on nothing-to-do', () => {
  const f = fixture('usage');
  const a = run([f.plan, '--from']);
  assert.equal(a.code, 2, `stdout: ${a.stdout}\nstderr: ${a.stderr}`);
  assert.match(a.stderr, /--from/, 'a flag missing its value must be named');

  const b = run([f.plan, '--wat']);
  assert.equal(b.code, 2, 'an unknown flag is a usage error');
  assert.match(b.stderr, /--wat/);

  const c = run([f.plan]);
  assert.equal(c.code, 2, 'neither --from nor --task is nothing to do');

  const d = run([f.plan, '--task', 'T1', '--from', 'x.log']);
  assert.equal(d.code, 2, 'evidence and an assertion are different claims; refuse the combination');

  rmSync(f.dir, { recursive: true, force: true });
});

test('--help exits 0 and prints the usage, the way the other plan CLIs do', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /usage:/);
  assert.match(r.stdout, /--from/);
  assert.match(r.stdout, /--task/);
});

// ---------- byte fidelity ----------

test('preserves CRLF line endings instead of rewriting the file in LF', () => {
  const f = fixture('crlf', { eol: '\r\n' });
  const r = runWithLog(f, LOG_T1_PASSED);
  assert.equal(r.r.code, 0, r.r.stderr);

  const after = readFileSync(f.plan, 'utf8');
  assert.equal(after.includes('\r\n'), true, 'the CRLF endings must survive');
  assert.equal(after.replaceAll('\r\n', '\n').includes('\n\n\n'), false, 'no line may be split');
  const changed = diff(FIXTURE_LINES, after.split('\r\n'));
  assert.deepEqual(changed, [[19, L(19), ticked(L(19))], [21, L(21), ticked(L(21))]]);
  rmSync(f.dir, { recursive: true, force: true });
});

// ---------- the log parser, directly ----------

// The parser is the part that has to be wrong-proof, so it gets tested against
// inputs that LOOK like a runner record without being one.
test('parseRunnerLog reads only the runner\'s own status lines', () => {
  const noise = [
    'Plan: 2099-01-01-fixture  schema=ultra-plan/v1  status=Draft  tasks=2',
    'T1: PASSED is what the runner prints, said in prose at column 0',
    '  WARN: runner_contract is not true',
    '  T1: NOT-A-REAL-STATUS',
    '  T1: PASSED',
    '  T2: HALTED-UPSTREAM',
  ].join('\n');
  const { byId, order, ledger } = md.parseRunnerLog(noise);
  assert.deepEqual(order, ['T1', 'T2'], 'only the runner\'s status tokens may become a task record');
  assert.equal(byId.get('T1').klass, 'success');
  assert.equal(byId.get('T1').detail, 'PASSED');
  assert.equal(byId.get('T2').klass, 'halted');
  assert.equal(byId.get('T2').success, false, 'HALTED-UPSTREAM is not a success');
  assert.equal(ledger.size, 0, 'a status line is not a ledger row');
});

test('parseRunnerLog collects the Error Ledger rows, and skips the table header', () => {
  const { ledger } = md.parseRunnerLog(LOG_T1_FAILED);
  assert.deepEqual(ledger.get('T1'), [LEDGER_TABLE[3]]);
  assert.equal(ledger.has('Task'), false, "the header cell is the literal word `Task`, not a task id");
  assert.equal(ledger.has('---'), false, 'the separator row is all dashes, not a task id');
});

test('classifyStatus separates the two terminal successes from everything else', () => {
  assert.equal(md.classifyStatus('PASSED'), 'success');
  assert.equal(md.classifyStatus('SKIPPED-IDEMPOTENT (skip_if exit 0)'), 'success');
  for (const detail of [
    'NEEDS-AGENT (no frontmatter run[]; agent executes prose steps)',
    'READY (dry-run)',
    'HALTED-UPSTREAM',
    'FAILED-BLOCKING at step 2 (exit 1)',
    'FAILED-ISOLATED at step 4 (exit 3)',
    'something new the runner has never printed',
  ]) {
    assert.notEqual(md.classifyStatus(detail), 'success', `${detail} must not count as success`);
  }
});
