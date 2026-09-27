import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractFrontmatter,
  parseUltraPlanYaml,
  topoSort,
  descendants,
  validatePlan,
  executePlan,
  classifySkipIf,
  RUNNER_CONTRACT_KEYS,
} from './ultra-plan-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts', 'ultra-plan-runner.mjs');
const PUBLISHER = path.join(ROOT, 'scripts', 'plan-publish.mjs');

const SAMPLE_FM = `---
schema: ultra-plan/v1
plan_id: 2026-09-19-demo
status: Approved
version: 1
runner_contract: true
defaults:
  retry_transient_max: 2
  step_timeout_s: 90
  on_precondition_fail: stop-task-continue-independent
tasks:
  - id: T1
    depends_on: []
    files: { create: [src/a.ts], modify: [], test: [src/a.test.ts] }
    idempotency_key: "T1:src/a.ts"
    skip_if: "bun test src/a.test.ts"
    verify_exit: 0
  - id: T2
    depends_on: [T1]
    files: { create: [src/b.ts], modify: [], test: [src/b.test.ts] }
    idempotency_key: "T2:src/b.ts"
    skip_if: "bun test src/b.test.ts"
    verify_exit: 0
---
# Demo Implementation Plan

### Task T1: A
### Task T2: B

\`\`\`mermaid
flowchart TD
    T1["T1: A"] --> T2["T2: B"]
\`\`\`
`;

test('extractFrontmatter splits frontmatter and body', () => {
  const { frontmatter, body } = extractFrontmatter(SAMPLE_FM);
  assert.match(frontmatter, /schema: ultra-plan\/v1/);
  assert.match(body, /# Demo Implementation Plan/);
  assert.doesNotMatch(body, /schema: ultra-plan/);
});

test('extractFrontmatter throws when frontmatter missing', () => {
  assert.throws(() => extractFrontmatter('# no frontmatter here'), /frontmatter/i);
});

test('parseUltraPlanYaml parses scalars, defaults, and tasks', () => {
  const { frontmatter } = extractFrontmatter(SAMPLE_FM);
  const plan = parseUltraPlanYaml(frontmatter);
  assert.equal(plan.schema, 'ultra-plan/v1');
  assert.equal(plan.version, 1);
  assert.equal(plan.runner_contract, true);
  assert.equal(plan.defaults.retry_transient_max, 2);
  assert.equal(plan.defaults.step_timeout_s, 90);
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0].id, 'T1');
  assert.deepEqual(plan.tasks[0].depends_on, []);
  assert.deepEqual(plan.tasks[0].files.create, ['src/a.ts']);
  assert.deepEqual(plan.tasks[0].files.modify, []);
  assert.equal(plan.tasks[0].skip_if, 'bun test src/a.test.ts');
  assert.equal(plan.tasks[0].idempotency_key, 'T1:src/a.ts');
  assert.equal(plan.tasks[0].verify_exit, 0);
  assert.deepEqual(plan.tasks[1].depends_on, ['T1']);
});

test('topoSort orders dependents after dependencies', () => {
  const tasks = [
    { id: 'T2', depends_on: ['T1'] },
    { id: 'T3', depends_on: ['T2'] },
    { id: 'T1', depends_on: [] },
  ];
  const order = topoSort(tasks);
  assert.ok(order.indexOf('T1') < order.indexOf('T2'));
  assert.ok(order.indexOf('T2') < order.indexOf('T3'));
});

test('topoSort throws on cycle', () => {
  const tasks = [
    { id: 'A', depends_on: ['B'] },
    { id: 'B', depends_on: ['A'] },
  ];
  assert.throws(() => topoSort(tasks), /cycle/i);
});

test('descendants computes downstream blast radius', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
    { id: 'T3', depends_on: ['T2'] },
    { id: 'T4', depends_on: [] },
  ];
  const d = descendants('T1', tasks);
  assert.deepEqual([...d].sort(), ['T2', 'T3']);
  assert.equal(descendants('T4', tasks).size, 0);
});

test('validatePlan passes on a consistent plan', () => {
  const { frontmatter, body } = extractFrontmatter(SAMPLE_FM);
  const plan = parseUltraPlanYaml(frontmatter);
  const { errors } = validatePlan(plan, body);
  assert.deepEqual(errors, []);
});

test('validatePlan flags missing dependency, duplicate id, bad schema', () => {
  const plan = {
    schema: 'wrong/v9',
    tasks: [
      { id: 'T1', depends_on: ['GHOST'] },
      { id: 'T1', depends_on: [] },
    ],
  };
  const { errors } = validatePlan(plan, '');
  assert.ok(errors.some((e) => /schema/i.test(e)));
  assert.ok(errors.some((e) => /duplicate/i.test(e)));
  assert.ok(errors.some((e) => /GHOST/.test(e)));
});

test('validatePlan flags task id missing its heading or mermaid node', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T9', depends_on: [] }],
  };
  // A map exists, but T9 is never a node in it.
  const { errors } = validatePlan(plan, '# Plan\n### Task T9: x\n```mermaid\nflowchart TD\n    T1["T1: a"]\n```\n');
  assert.ok(errors.some((e) => /mermaid/i.test(e) && /T9/.test(e)));
});

test('validatePlan rejects a plan body with no mermaid diagram', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T1', depends_on: [] }],
  };
  const { errors } = validatePlan(plan, '# Plan\n### Task T1: x\nNo diagram here.\n');
  assert.ok(errors.some((e) => /at least one.*mermaid/i.test(e)));
});

// ---------- Mermaid as a machine-checked contract ----------
// The skill claims `depends_on` (frontmatter) == Mermaid edges == task headings.
// These tests hold that claim honest: both directions of drift must fail.

// Every task gets a hook so these fixtures are valid plans under the
// execution-hook contract. Without it each one also trips the unrelated
// "no run[] and no skip_if" error, and a Mermaid test that fails on a hook
// problem can no longer say what it is about.
const withHook = (tasks) => tasks.map((t) => (t.run || t.skip_if ? t : { ...t, skip_if: 'true' }));
const planWith = (tasks) => ({ schema: 'ultra-plan/v1', runner_contract: true, tasks: withHook(tasks) });
const headings = (ids) => ids.map((id) => `### Task ${id}: work`).join('\n');
const mapWith = (inner) => `# Plan\n\n\`\`\`mermaid\nflowchart TD\n${inner}\n\`\`\`\n`;

test('validatePlan accepts a plan whose mermaid edges match depends_on exactly', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
    { id: 'T3', depends_on: ['T1', 'T2'] },
  ];
  const body = headings(['T1', 'T2', 'T3']) + mapWith([
    '    T1["T1: a"] --> T2["T2: b"]',
    '    T1 --> T3["T3: c"]',
    '    T2 --> T3',
  ].join('\n'));
  const { errors } = validatePlan(planWith(tasks), body);
  assert.deepEqual(errors, []);
});

test('validatePlan flags a depends_on edge that is missing from the mermaid map', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
  ];
  // T2 exists as a node but no T1 --> T2 edge exists.
  const body = headings(['T1', 'T2']) + mapWith('    T1["T1: a"]\n    T2["T2: b"]');
  const { errors } = validatePlan(planWith(tasks), body);
  assert.ok(
    errors.some((e) => /T1/.test(e) && /T2/.test(e) && /depends_on|edge/i.test(e)),
    `expected a missing-edge error, got: ${JSON.stringify(errors)}`,
  );
});

test('validatePlan flags a mermaid edge between task nodes that is absent from depends_on', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: [] },
  ];
  // Diagram claims T1 -> T2 but frontmatter says T2 depends on nothing.
  const body = headings(['T1', 'T2']) + mapWith('    T1["T1: a"] --> T2["T2: b"]');
  const { errors } = validatePlan(planWith(tasks), body);
  assert.ok(
    errors.some((e) => /T1/.test(e) && /T2/.test(e) && /does not declare|absent|extra/i.test(e)),
    `expected an undeclared-edge error, got: ${JSON.stringify(errors)}`,
  );
});

test('validatePlan ignores edges where an endpoint is not a task (gates, entry nodes)', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
  ];
  const body = headings(['T1', 'T2']) + mapWith([
    '    Start(["Start"]) --> T1["T1: a"]',
    '    T1 --> Gate{{"Human approval"}}',
    '    T1 --> T2["T2: b"]',
    '    Gate --> T2',
    '    T2 --> Verify["Verify"]',
  ].join('\n'));
  const { errors } = validatePlan(planWith(tasks), body);
  assert.deepEqual(errors, [], `gate/entry edges must not be flagged: ${JSON.stringify(errors)}`);
});

test('validatePlan requires a direct edge, not merely transitive reachability', () => {
  // Deliberate design decision: the contract is `depends_on` == Mermaid edges,
  // one edge per dependency. Reachability is not enough, because deleting an
  // arrow must fail loudly instead of silently leaving a stale map.
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: [] },
    { id: 'T3', depends_on: ['T1'] },
  ];
  const body = headings(['T1', 'T2', 'T3']) + mapWith([
    '    T1 --> T2',
    '    T2 --> T3["T3: c"]',
  ].join('\n'));
  const { errors } = validatePlan(planWith(tasks), body);
  assert.ok(
    errors.some((e) => /T1/.test(e) && /T3/.test(e) && /no edge T1 --> T3/.test(e)),
    `expected a direct-edge error for T3, got: ${JSON.stringify(errors)}`,
  );
});

test('validatePlan does not count a task id that appears only inside an unrelated diagram label', () => {
  const tasks = [{ id: 'T1', depends_on: [] }, { id: 'T7', depends_on: ['T1'] }];
  const body = headings(['T1', 'T7']) + [
    mapWith('    T1["T1: a"] --> T7["T7: b"]'),
    // A second, unrelated diagram that merely mentions T7 as prose.
    '```mermaid\nflowchart LR\n    Note["Rollback: rerun T7 if it fails"] --> End(["End"])\n```\n',
  ].join('\n');
  const { errors } = validatePlan(planWith(tasks), body);
  // T7 is a real node in the first map, so this must pass; the label mention is noise.
  assert.deepEqual(errors, []);
});

test('validatePlan flags a task that is missing from the map even if its id is prose in another block', () => {
  const tasks = [{ id: 'T1', depends_on: [] }, { id: 'T7', depends_on: ['T1'] }];
  const body = headings(['T1', 'T7']) + [
    mapWith('    T1["T1: a"]'),
    '```mermaid\nflowchart LR\n    Note["T7 needs attention"] --> End(["End"])\n```\n',
  ].join('\n');
  const { errors } = validatePlan(planWith(tasks), body);
  assert.ok(
    errors.some((e) => /T7/.test(e) && /node/i.test(e)),
    `expected a missing-node error for T7, got: ${JSON.stringify(errors)}`,
  );
});

test('validatePlan recognizes labelled, dotted, and thick edge syntaxes', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
    { id: 'T3', depends_on: ['T2'] },
  ];
  const body = headings(['T1', 'T2', 'T3']) + mapWith([
    '    T1["a"] -->|yes| T2["b"]',
    '    T2 -.-> T3["c"]',
  ].join('\n'));
  const { errors } = validatePlan(planWith(tasks), body);
  assert.deepEqual(errors, []);
});

test('validatePlan does not read task edges out of a non-flowchart diagram', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
  ];
  // Arrows inside a sequenceDiagram are interactions, not dependencies.
  const body = headings(['T1', 'T2']) + '```mermaid\nsequenceDiagram\n    Parent->>Sub: chunk\n    T1->>T2: not a dependency\n```\n';
  const { errors } = validatePlan(planWith(tasks), body);
  assert.ok(
    errors.some((e) => /flowchart or graph/i.test(e)),
    `expected a missing-visual-map error, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => /depends_on/.test(e)),
    `sequence arrows must not be read as task edges: ${JSON.stringify(errors)}`,
  );
});

test('validatePlan accepts a plan with a flowchart map plus a sequence diagram', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
  ];
  const body = headings(['T1', 'T2'])
    + mapWith('    T1["T1: a"] --> T2["T2: b"]')
    + '```mermaid\nsequenceDiagram\n    Parent->>Sub: dispatch T1 then T2\n```\n';
  const { errors } = validatePlan(planWith(tasks), body);
  assert.deepEqual(errors, []);
});

test('validatePlan treats a node that only appears as an edge endpoint as present', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
  ];
  // T2 is never given its own shape declaration.
  const body = headings(['T1', 'T2']) + mapWith('    T1["T1: a"] --> T2');
  const { errors } = validatePlan(planWith(tasks), body);
  assert.deepEqual(errors, []);
});

// ---------- execution-hook contract ----------

// The runner's whole point is executing a plan. `run[]` is the only key that
// makes it do anything, and until these tests existed nothing covered it: the
// suite exercised frontmatter, the DAG, the Mermaid contract, and the mirror
// gate, then stopped. `executePlan` had zero references, so a regression in
// retry accounting, exit-code matching, or blast-radius classification would
// have shipped green.

const execDir = mkdtempSync(path.join(tmpdir(), 'ultra-runner-exec-'));
process.on('exit', () => rmSync(execDir, { recursive: true, force: true }));

const abs = (f) => path.join(execDir, f);

// Fails on the first run, succeeds on the second. A real file-based counter
// rather than a quoted one-liner, so the test asserts the runner's retry loop
// and not the shell's parsing.
const flaky = abs('flaky.sh');
writeFileSync(flaky, '#!/bin/sh\n'
  + 'd=$(dirname "$0")\n'
  + 'n=$(cat "$d/count" 2>/dev/null || echo 0)\n'
  + 'n=$((n+1))\n'
  + 'echo "$n" > "$d/count"\n'
  + '[ "$n" -ge 2 ]\n');
chmodSync(flaky, 0o755);

function runPlan(tasks, defaults = {}) {
  return executePlan(
    { tasks, defaults: { retry_transient_max: 0, step_timeout_s: 30, ...defaults } },
    { execute: true },
  );
}

test('block-style run[] parses as steps of the task it belongs to', () => {
  const { frontmatter } = extractFrontmatter(`---
schema: ultra-plan/v1
plan_id: 2026-09-28-blockrun
status: Approved
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    run:
      - cmd: "bun test a.test.ts"
        expect_exit: 0
        retry: 2
    skip_if: "bun test a.test.ts"
---
# p
`);
  const plan = parseUltraPlanYaml(frontmatter);
  // The regression this locks: the `- cmd` line used to open a NEW task, so
  // the plan came back with 2 tasks, the second one id-less.
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].id, 'T1');
  assert.equal(plan.tasks[0].run.length, 1);
  assert.equal(plan.tasks[0].run[0].cmd, 'bun test a.test.ts');
  assert.equal(plan.tasks[0].run[0].expect_exit, 0);
  assert.equal(plan.tasks[0].run[0].retry, 2);
  // A sibling key after the block must not be swallowed by the sequence.
  assert.equal(plan.tasks[0].skip_if, 'bun test a.test.ts');
});

test('executePlan runs every step and reports PASSED', () => {
  const out = abs('made.txt');
  rmSync(out, { force: true });
  const { status, ledger } = runPlan([{
    id: 'T1',
    depends_on: [],
    run: [
      { cmd: `printf hello > ${out}` },
      { cmd: `grep -q hello ${out}` },
    ],
  }]);
  assert.equal(status.get('T1'), 'PASSED');
  assert.equal(ledger.length, 0);
  assert.match(readFileSync(out, 'utf8'), /hello/);
});

test('executePlan honours a non-zero expect_exit, so a RED step can pass', () => {
  const { status, ledger } = runPlan([{
    id: 'T1',
    depends_on: [],
    run: [{ cmd: `test -f ${abs('never-created')}`, expect_exit: 1 }],
  }]);
  assert.equal(status.get('T1'), 'PASSED');
  assert.equal(ledger.length, 0);
});

test('executePlan retries a transient failure and counts the retry', () => {
  rmSync(abs('count'), { force: true });
  const { status, ledger } = runPlan(
    [{ id: 'T1', depends_on: [], run: [{ cmd: flaky, retry: 1 }] }],
    { retry_transient_max: 1 },
  );
  assert.equal(status.get('T1'), 'PASSED');
  assert.equal(ledger.length, 0);
});

test('executePlan does not retry when retry is 0, and records the step and exit', () => {
  rmSync(abs('count'), { force: true });
  const { status, ledger } = runPlan([{ id: 'T1', depends_on: [], run: [{ cmd: flaky, retry: 0 }] }]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].step, 1);
  assert.equal(ledger[0].retry, '0/0');
  assert.equal(ledger[0].exit, 1);
});

test('a task with no dependents fails ISOLATED and the run continues', () => {
  const { status, order } = runPlan([
    { id: 'T1', depends_on: [], run: [{ cmd: 'exit 3' }] },
    { id: 'T2', depends_on: [], run: [{ cmd: 'true' }] },
  ]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(status.get('T2'), 'PASSED');
  assert.deepEqual(order, ['T1', 'T2']);
});

test('a task others depend on fails BLOCKING and halts only its descendants', () => {
  const { status, ledger } = runPlan([
    { id: 'T1', depends_on: [], run: [{ cmd: 'exit 1' }] },
    { id: 'T2', depends_on: ['T1'], run: [{ cmd: 'true' }] },
    { id: 'T3', depends_on: ['T2'], run: [{ cmd: 'true' }] },
    { id: 'T4', depends_on: [], run: [{ cmd: 'true' }] },
  ]);
  assert.equal(status.get('T1'), 'FAILED-BLOCKING');
  assert.equal(status.get('T2'), 'HALTED-UPSTREAM');
  assert.equal(status.get('T3'), 'HALTED-UPSTREAM');
  assert.equal(status.get('T4'), 'PASSED');
  // The ledger carries the failure and every halt it caused, so the blast
  // radius is auditable; only T1 is the actual failing step.
  assert.deepEqual(ledger.map((e) => `${e.task}:${e.status}`), [
    'T1:FAILED-BLOCKING', 'T2:HALTED-UPSTREAM', 'T3:HALTED-UPSTREAM',
  ]);
  assert.equal(ledger.find((e) => e.task === 'T1').step, 1);
});

test('a step that outlives step_timeout_s is killed and reported as 124', () => {
  const { status, ledger } = runPlan(
    [{ id: 'T1', depends_on: [], run: [{ cmd: 'sleep 5', retry: 0 }] }],
    { step_timeout_s: 1 },
  );
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger[0].exit, 124);
});

test('skip_if exiting 0 short-circuits the task before any step runs', () => {
  const marker = abs('never-written.txt');
  rmSync(marker, { force: true });
  const { status, ledger } = runPlan([{
    id: 'T1',
    depends_on: [],
    skip_if: 'true',
    run: [{ cmd: `printf ran > ${marker}` }],
  }]);
  assert.equal(status.get('T1'), 'SKIPPED-IDEMPOTENT');
  assert.equal(ledger.length, 0);
  assert.equal(existsSync(marker), false);
});

test('a task with skip_if but no run[] is reported NEEDS-AGENT, not silently skipped', () => {
  const { status, ledger } = runPlan([{ id: 'T1', depends_on: [], skip_if: 'false' }]);
  assert.equal(status.get('T1'), 'NEEDS-AGENT');
  assert.equal(ledger.length, 0);
});

test('validatePlan rejects a task with neither run[] nor skip_if', () => {
  const plan = { schema: 'ultra-plan/v1', tasks: [{ id: 'T1', depends_on: [] }] };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /T1 has no execution hook/.test(e)), errors.join(' | '));
});

test('validatePlan rejects a run[] step with no cmd', () => {
  const plan = { schema: 'ultra-plan/v1', tasks: [{ id: 'T1', depends_on: [], run: [{ expect_exit: 0 }] }] };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /run\[0\] has no cmd/.test(e)), errors.join(' | '));
});

test('validatePlan warns, but does not block, when a task only has skip_if', () => {
  const plan = { schema: 'ultra-plan/v1', tasks: [{ id: 'T1', depends_on: [], skip_if: 'bun test a.test.ts' }] };
  const { errors, warnings } = validatePlan(plan, null);
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((w) => /T1 declares skip_if but no run\[\]/.test(w)), warnings.join(' | '));
});

test('classifySkipIf separates a behavioural check from a file-content probe', () => {
  // Behavioural: a tool has to succeed first, so the probe reads its output.
  assert.equal(classifySkipIf("bun test a.test.ts 2>&1 | grep -q 'passes'"), 'behavioural');
  assert.equal(classifySkipIf('systemctl --user is-active foo.timer'), 'behavioural');
  assert.equal(classifySkipIf('git diff --quiet -- path'), 'behavioural');
  // Loose: proves a string is present in a file, nothing more. It survives the
  // string being moved into a comment, and plan-mark-done then ticks the task.
  assert.equal(classifySkipIf("grep -q 'Plan Publish Gate' snippets/x.md"), 'loose');
  assert.equal(classifySkipIf('test -f out.txt'), 'loose');
  assert.equal(classifySkipIf('ls dist/'), 'loose');
});

test('a behavioural skip_if that greps a tool is not a file-content probe', () => {
  // The distinction that has to hold: a grep filtering a test run is
  // behavioural, because the runner has to exit 0 before the grep sees
  // anything. A grep reading a file is not.
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T1', depends_on: [], skip_if: "bun test a.test.ts 2>&1 | grep -q 'passes'" }],
  };
  const { errors } = validatePlan(plan, null);
  assert.deepEqual(errors, []);
});

test('a double-quoted cmd keeps one backslash, not two', () => {
  // The defect this locks: `coerceScalar` stripped the quotes without expanding
  // escapes, so `run\\[\\]` reached the shell as `run\\[\\]` and the step failed
  // with "exit mismatch" and no hint that the string had been misparsed. A plan
  // author writing a regex in a grep hit a command the runner never sent.
  const { frontmatter } = extractFrontmatter(`---
schema: ultra-plan/v1
plan_id: 2026-09-28-escape
status: Approved
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    run:
      - cmd: "grep -q 'run\\[\\]' src/x.md"
        expect_exit: 0
        retry: 0
---
# p
`);
  const plan = parseUltraPlanYaml(frontmatter);
  // The plan author wrote two backslashes; the shell must receive one.
  assert.equal(plan.tasks[0].run[0].cmd, "grep -q 'run\\[\\]' src/x.md");
});

test('an unrecognised escape survives, because cmd fields carry regexes', () => {
  const { frontmatter } = extractFrontmatter(`---
schema: ultra-plan/v1
plan_id: 2026-09-28-escape2
status: Approved
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    run:
      - cmd: "grep -q 'a\\db' src/x.md"
        expect_exit: 0
        retry: 0
---
# p
`);
  const plan = parseUltraPlanYaml(frontmatter);
  assert.equal(plan.tasks[0].run[0].cmd, "grep -q 'a\\db' src/x.md");
});

test('a single-quoted scalar is literal, as YAML specifies', () => {
  const { frontmatter } = extractFrontmatter(`---
schema: ultra-plan/v1
plan_id: 2026-09-28-escape3
status: Approved
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    run:
      - cmd: 'grep -q "run\\[\\]" src/x.md'
        expect_exit: 0
        retry: 0
---
# p
`);
  const plan = parseUltraPlanYaml(frontmatter);
  assert.equal(plan.tasks[0].run[0].cmd, 'grep -q "run\\[\\]" src/x.md');
});

test('a double-quoted escape for a quote and a tab is expanded', () => {
  const { frontmatter } = extractFrontmatter(`---
schema: ultra-plan/v1
plan_id: 2026-09-28-escape4
status: Approved
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    run:
      - cmd: "echo \\"a\\"\\tb"
        expect_exit: 0
        retry: 0
---
# p
`);
  const plan = parseUltraPlanYaml(frontmatter);
  assert.equal(plan.tasks[0].run[0].cmd, 'echo "a"\tb');
});

test('a parsed cmd is what the shell actually receives', () => {
  // End-to-end: the point of the three tests above is that this command runs.
  const marker = abs('escape-target.txt');
  writeFileSync(marker, 'run[]\n');
  const { status } = runPlan([{
    id: 'T1',
    depends_on: [],
    run: [{ cmd: `grep -q 'run\\[\\]' ${marker}`, expect_exit: 0 }],
  }]);
  assert.equal(status.get('T1'), 'PASSED');
});

test('RUNNER_CONTRACT_KEYS names the keys the template has to document', () => {
  // This list is what validate-skill.mjs checks the template against. If the
  // runner grows a new input, adding it here is the only way CI notices that
  // the template was never updated.
  for (const k of ['schema', 'tasks[].id', 'tasks[].depends_on', 'tasks[].skip_if', 'tasks[].run', 'tasks[].run[].cmd']) {
    assert.ok(RUNNER_CONTRACT_KEYS.includes(k), `missing contract key: ${k}`);
  }
  // The four keys that were documented but unread are now read, so they belong
  // here. A key listed but unimplemented is the exact defect this list exists
  // to prevent, so there must be none.
  for (const k of ['tasks[].files', 'tasks[].verify_exit', 'tasks[].idempotency_key', 'defaults.on_precondition_fail']) {
    assert.ok(RUNNER_CONTRACT_KEYS.includes(k), `${k} is documented but not enforced`);
  }
  // And none of them may claim a key the runner never touches.
  for (const k of ['tasks[].notes', 'tasks[].agent_hint', 'defaults.magic']) {
    assert.ok(!RUNNER_CONTRACT_KEYS.includes(k), `${k} is not read by the runner`);
  }
});

// ---------- verify_exit, files, idempotency_key, on_precondition_fail ----------
//
// These four were documented in the template and read by nothing. Documenting a
// key that does nothing is worse than not documenting it, because the plan
// looks precise. Each one is now enforced, and each has a test that fails when
// the enforcement is removed.

test('a step with no expect_exit falls back to verify_exit', () => {
  // verify_exit: 2 means "this task's steps are expected to exit 2". A step that
  // says nothing inherits it, so the field is a real default rather than a
  // decorative copy of 0.
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [], verify_exit: 2,
    run: [{ cmd: 'exit 2' }],
  }]);
  assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
});

test('an explicit expect_exit still overrides verify_exit', () => {
  const { status } = runPlan([{
    id: 'T1', depends_on: [], verify_exit: 2,
    run: [{ cmd: 'exit 1', expect_exit: 1 }],
  }]);
  assert.equal(status.get('T1'), 'PASSED');
});

test('a declared file that is absent before the task runs fails the precondition', () => {
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [],
    files: { create: [], modify: [abs('does-not-exist.ts')], test: [] },
    run: [{ cmd: 'true' }],
  }]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger[0].step, 'pre');
  assert.match(ledger[0].cause, /absent before the task ran/);
});

test('a declared create file still missing after the steps ran fails the postcondition', () => {
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [],
    files: { create: [abs('never-made.txt')], modify: [], test: [] },
    run: [{ cmd: 'true' }],
  }]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.match(ledger[0].cause, /still absent after the task ran/);
});

test('a create file that appears is a pass, so a re-run stays idempotent', () => {
  const target = abs('reused.txt');
  writeFileSync(target, 'already here\n');
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [],
    files: { create: [target], modify: [], test: [] },
    run: [{ cmd: `grep -q already ${target}` }],
  }]);
  assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
});

test('a task that declares no files is unaffected by the file checks', () => {
  const { status } = runPlan([{ id: 'T1', depends_on: [], run: [{ cmd: 'true' }] }]);
  assert.equal(status.get('T1'), 'PASSED');
});

test('validatePlan rejects an idempotency_key that names a different task', () => {
  const plan = { schema: 'ultra-plan/v1', tasks: [{ id: 'T1', depends_on: [], idempotency_key: 'T2:a.ts', skip_if: 'true' }] };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /names task "T2"/.test(e)), errors.join(' | '));
});

test('an idempotency_key may name a behaviour rather than a path', () => {
  // The key names the task's unit of work, and in every real plan in this
  // repository that is a description, not a filename: `T3:two-stage-trigger`,
  // `T5:lifecycle-audit`, `T18:bulk-publish-267`. A first draft of this check
  // demanded the right-hand side be a declared file path, which rejected all of
  // them and broke four plans that had nothing wrong with them.
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{
      id: 'T3', depends_on: [], idempotency_key: 'T3:two-stage-trigger',
      files: { create: [], modify: ['snippets/x.md'], test: [] },
      skip_if: 'bun test a.test.ts',
    }],
  };
  const { errors } = validatePlan(plan, null);
  assert.deepEqual(errors, []);
});

test('every plan in docs/code-plan/plans still validates', () => {
  // The regression this locks. A check added to the runner is a check every
  // existing plan must survive; four of them failed it on the first run, which
  // is exactly the shape of breakage a unit test on the new check alone misses.
  const dir = path.join(ROOT, 'docs', 'code-plan', 'plans');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'no plans found to check');
  const broken = [];
  for (const f of files) {
    const { frontmatter } = extractFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    const { errors } = validatePlan(parseUltraPlanYaml(frontmatter), null);
    if (errors.length) broken.push(`${f}: ${errors.join('; ')}`);
  }
  assert.deepEqual(broken, []);
});

test('a loose skip_if is a hard error once the allowlist exists', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T3', depends_on: [], skip_if: "grep -q 'Marker' src/x.md" }],
  };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /T3 skip_if is a file-content probe/.test(e)), errors.join(' | '));
});

test('an allowlisted loose skip_if passes', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    defaults: { allow_loose_skip_if: ['T3'] },
    tasks: [{ id: 'T3', depends_on: [], skip_if: "grep -q 'Marker' src/x.md" }],
  };
  const { errors } = validatePlan(plan, null);
  assert.deepEqual(errors, []);
});

test('a stale exemption is itself an error, so the allowlist cannot become permanent', () => {
  // The failure mode of any allowlist is that it outlives its reason. A name
  // that no longer corresponds to a loose skip_if is dead weight that hides a
  // future regression, so it is reported rather than ignored.
  const plan = {
    schema: 'ultra-plan/v1',
    defaults: { allow_loose_skip_if: ['T1', 'TGONE'] },
    tasks: [{ id: 'T1', depends_on: [], skip_if: 'bun test a.test.ts' }],
  };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /allow_loose_skip_if names "TGONE"/.test(e)), errors.join(' | '));
  assert.ok(errors.some((e) => /allow_loose_skip_if names "T1"/.test(e)), errors.join(' | '));
});

test('on_precondition_fail: halt-plan stops independent tasks too', () => {
  const { status } = runPlan(
    [
      { id: 'T1', depends_on: [], files: { create: [], modify: [abs('nope.ts')], test: [] }, run: [{ cmd: 'true' }] },
      { id: 'T2', depends_on: [], run: [{ cmd: 'true' }] },
    ],
    { on_precondition_fail: 'halt-plan' },
  );
  assert.equal(status.get('T1'), 'FAILED-BLOCKING');
  // T2 does not depend on T1, so under the permissive policy it would still run.
  assert.equal(status.get('T2'), 'HALTED-PLAN');
});

test('on_precondition_fail: stop-task-continue-independent keeps independent work running', () => {
  const { status } = runPlan([
    { id: 'T1', depends_on: [], files: { create: [], modify: [abs('nope.ts')], test: [] }, run: [{ cmd: 'true' }] },
    { id: 'T2', depends_on: [], run: [{ cmd: 'true' }] },
  ]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(status.get('T2'), 'PASSED');
});

test('an unrecognised on_precondition_fail throws instead of defaulting to the permissive value', () => {
  assert.throws(
    () => runPlan([{ id: 'T1', depends_on: [], run: [{ cmd: 'true' }] }], { on_precondition_fail: 'stop-everything' }),
    /on_precondition_fail/,
  );
});

// ---------- vault mirror gate (T2) ----------
//
// The runner is the one place that can make "publish the plan" mandatory instead
// of advisory, because it is the last thing that runs before a task step
// executes. These cases drive the real CLI as a SUBPROCESS against a throwaway
// vault, for the same reason the publisher tests do: the contract is an exit
// code plus what did or did not run, and an in-process call cannot prove
// process.exit() behaviour.
//
// Nothing here touches the real vault. PLAN_PUBLISH_CONFIG redirects the
// registry, which is the seam the publisher was built with.

const GATE_PLAN = '2026-09-27-gate-demo.md';

// A minimal VALID plan: one task, `skip_if` but no `run[]` steps. No run[]
// means the runner reports NEEDS-AGENT and executes nothing, which is exactly
// what lets these tests assert "the DAG was reached" versus "the gate stopped
// it" without any task command being able to fail for an unrelated reason.
// The `skip_if` is what keeps the fixture valid under the execution-hook
// contract: a task with neither run[] nor skip_if is a validation error, and
// an errored plan never reaches the gate at all — which would make these tests
// pass for the wrong reason.
function gatePlanBody() {
  return `---
schema: ultra-plan/v1
plan_id: 2026-09-27-gate-demo
status: Approved
version: 1
runner_contract: true
defaults:
  retry_transient_max: 1
  step_timeout_s: 30
  on_precondition_fail: stop-task-continue-independent
tasks:
  - id: T1
    depends_on: []
    files: { create: [src/a.ts], modify: [], test: [] }
    idempotency_key: "T1:src/a.ts"
    skip_if: "true"
    verify_exit: 0
---
# Gate demo

### Task T1: A

\`\`\`mermaid
flowchart TD
    T1["T1: A"] --> Done["done"]
\`\`\`
`;
}

function gateFixture(tag, { mirror = true } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), `runner-gate-${tag}-`));
  const vault = path.join(base, 'vault');
  const projectRoot = path.join(base, 'proj');
  const plansDir = path.join(projectRoot, 'docs', 'code-plan', 'plans');
  mkdirSync(vault, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: vault, encoding: 'utf8' });
  mkdirSync(plansDir, { recursive: true });
  // `mirror` toggles the registry flag, which is how the vault's own plans are
  // declared: they are already inside the vault, so there is no mirror to be
  // current about and the gate must not apply.
  const config = path.join(base, 'plans.publish.json');
  writeFileSync(config, JSON.stringify({
    vault,
    destDirTemplate: '01 - Projects/{project}/plans',
    stageInVault: true,
    projects: [{ name: 'demo', root: projectRoot, mirror }],
  }, null, 2), 'utf8');
  const plan = path.join(plansDir, GATE_PLAN);
  writeFileSync(plan, gatePlanBody(), 'utf8');
  return { base, vault, projectRoot, plansDir, config, plan };
}

function runRunner(f, args) {
  const r = spawnSync(process.execPath, [RUNNER, f.plan, ...args], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PLAN_PUBLISH_CONFIG: f.config },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function publish(f) {
  const r = spawnSync(process.execPath, [PUBLISHER, f.plan], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PLAN_PUBLISH_CONFIG: f.config },
  });
  assert.equal(r.status, 0, `publish failed: ${r.stderr}`);
}

test('refuses to execute a plan whose mirror is stale', () => {
  const f = gateFixture('stale');
  try {
    // 1. Never published. The whole reason this gate exists: a plan that is
    //    perfectly valid, in a project, with nothing in the vault.
    let r = runRunner(f, ['--execute']);
    assert.equal(r.code, 3, `an unpublished plan must not execute, got ${r.code}:\n${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /NEEDS-AGENT/, 'no task step may run while the gate is closed');
    assert.match(`${r.stdout}${r.stderr}`, /MIRROR GATE/, 'the block must be visible in the output');
    assert.ok(`${r.stdout}${r.stderr}`.includes(GATE_PLAN), 'the block must name the plan');
    assert.match(`${r.stdout}${r.stderr}`, /planFreshness|no mirror|MISSING/i,
      'the block must say why, not just that it failed');
    // The fix has to be copy-pasteable, because the person hitting this is
    // mid-plan and should not have to reconstruct the command.
    assert.match(`${r.stdout}${r.stderr}`, /plan-publish\.mjs/, 'the block must name the publish command');

    // 2. Published, then the source edited. This is the case that used to slip
    //    through: the mirror exists, so a presence check would pass it.
    publish(f);
    r = runRunner(f, ['--execute']);
    assert.notEqual(r.code, 3, `a current mirror must execute, got:\n${r.stdout}${r.stderr}`);

    appendFileSync(f.plan, '\nedited after publishing\n', 'utf8');
    r = runRunner(f, ['--execute']);
    assert.equal(r.code, 3, `a drifted mirror must not execute, got ${r.code}:\n${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /NEEDS-AGENT/, 'no task step may run on drift');
    assert.match(`${r.stdout}${r.stderr}`, /!=/, `the block must show both hashes:\n${r.stdout}${r.stderr}`);

    // 3. Republish and it runs again. A gate with no way back is a dead end.
    publish(f);
    r = runRunner(f, ['--execute']);
    assert.notEqual(r.code, 3, `republishing must unblock, got:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /NEEDS-AGENT/, 'the DAG must actually be reached after republishing');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('the mirror gate does not apply where there is no mirror', () => {
  // mirror:false — the vault's own plans. Gating these would make every vault
  // plan unrunnable, so the gate must step aside rather than invent a mirror.
  const f = gateFixture('notapplicable', { mirror: false });
  try {
    const r = runRunner(f, ['--execute']);
    assert.notEqual(r.code, 3, `a mirror:false plan must not be gated, got:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /NEEDS-AGENT/, 'the DAG must be reached');
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /MIRROR GATE: BLOCKED/,
      'a not-applicable gate must not be reported as a block');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('a dry run is never gated', () => {
  // Plan validation must keep working on a machine with no vault at all: that
  // is the common case for anyone reading or writing a plan.
  const f = gateFixture('dryrun');
  try {
    const r = runRunner(f, []);
    assert.equal(r.code, 0, `validation must not need a mirror, got ${r.code}:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Validation: OK/);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /MIRROR GATE/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('the escape flag runs the DAG and says it was used', () => {
  const f = gateFixture('escape');
  try {
    const r = runRunner(f, ['--execute', '--skip-mirror-gate']);
    assert.notEqual(r.code, 3, `the escape must actually escape, got:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /NEEDS-AGENT/, 'the DAG must be reached');
    // Silently passing is how an escape hatch becomes the default. It must be
    // loud every single time it is used.
    assert.match(`${r.stdout}${r.stderr}`, /skip-mirror-gate/,
      'using the escape must be reported in the output');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('an unresolvable plan fails the gate closed, not open', () => {
  const f = gateFixture('unroutable');
  try {
    // A plan outside every registered project root. Failing open here would
    // mean a typo'd path silently executes with no mirror, which is precisely
    // the class of bug this gate is here to prevent.
    const outside = path.join(f.base, 'elsewhere', 'plan.md');
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, gatePlanBody(), 'utf8');
    const r = spawnSync(process.execPath, [RUNNER, outside, '--execute'], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, PLAN_PUBLISH_CONFIG: f.config },
    });
    assert.equal(r.status, 3, `an unroutable plan must fail closed, got ${r.status}:\n${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /plans\.publish\.json/, 'the block must name the file to fix');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
