// scripts/plan-lifecycle-audit.test.mjs
//
// Guards for the plan lifecycle audit. The audit exists because `status: Draft`
// in a vault mirror has TWO origins that mean opposite things:
//
//   * the plan file has no frontmatter at all, so the publisher fell back to a
//     default (`verbatimStatus ?? 'status: Draft'` in plan-publish-frontmatter.mjs),
//     and the mirror is reporting that the plan has never been in a lifecycle at
//     all — it says NOTHING about the work;
//   * the plan file declares `status: Draft`, which is a real claim and may be a
//     stale one.
//
// A report that conflates them produces a number nobody can act on, and a
// backfill built on that number would be fabrication rather than maintenance. So
// the three buckets are the contract under test here, not the arithmetic.
//
// Every fixture is a throwaway registry under the system temp dir. Nothing in
// this file reads or writes /home/belajarcarabelajar/Dokumen/Obsidian Vault, and
// nothing depends on whether the real project checkouts exist on the machine
// running it.
//
// Namespace import, not a named one, for the same reason plan-publish.test.mjs
// uses one: a named import of a symbol that does not exist is a module LINK
// error, which aborts the whole file before a single test runs. With a namespace
// the file loads and every assertion below reports its own failure, which is
// what a red run is for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as audit from './plan-lifecycle-audit.mjs';
// The registry module is imported here rather than in the module under test, so
// the test can build the SAME registry object the CLI builds and hand it to
// auditPlans() in-process. If auditPlans() grew its own directory walk instead of
// calling enumeratePlans(), these tests would still pass — which is exactly why
// the CLI tests below go through PLAN_PUBLISH_CONFIG as well.
import { loadRegistry } from './plan-publish-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'plan-lifecycle-audit.mjs');

// ---------- fixtures ----------

// A registry of one mirror:true project, entirely under a temp dir. `plans` maps
// a filename to its exact file text, so a test can spell out whether a plan
// opens with a frontmatter fence, and whether it declares a status.
function fixture(tag, plans) {
  const base = mkdtempSync(path.join(tmpdir(), `plan-audit-${tag}-`));
  const vault = path.join(base, 'vault');
  const root = path.join(base, 'proj');
  const plansDir = path.join(root, 'docs', 'code-plan', 'plans');
  mkdirSync(vault, { recursive: true });
  mkdirSync(plansDir, { recursive: true });
  for (const [name, text] of Object.entries(plans)) {
    writeFileSync(path.join(plansDir, name), text, 'utf8');
  }
  const config = path.join(base, 'plans.publish.json');
  writeFileSync(config, JSON.stringify({
    vault,
    destDirTemplate: '01 - Projects/{project}/plans',
    stageInVault: false,
    projects: [{ name: 'demo', root, mirror: true }],
  }, null, 2), 'utf8');
  return {
    base, vault, root, plansDir, config,
    write(name, text) {
      writeFileSync(path.join(plansDir, name), text, 'utf8');
    },
    cleanup() { rmSync(base, { recursive: true, force: true }); },
  };
}

function run(args, f, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PLAN_PUBLISH_CONFIG: f.config, ...extraEnv },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------- classify: one plan, in isolation ----------

test('classifyPlan buckets a plan with no frontmatter as untracked', () => {
  const c = audit.classifyPlan('# Just a plan\n\nNo frontmatter at all.\n');
  assert.equal(c.bucket, 'untracked', 'a body with no leading --- fence is untracked');
  assert.equal(c.declaresFrontmatter, false);
  // An untracked plan has no status of its own to read. Reporting a value here
  // is the exact conflation this script exists to prevent.
  assert.equal(c.statusValue, null);
  assert.equal(c.statusLine, null);
  assert.equal(c.status, null);
});

test('classifyPlan buckets a plan that declares a status as tracked, verbatim', () => {
  const c = audit.classifyPlan('---\nschema: ultra-plan/v1\nstatus: Verification\n---\n\n# Plan\n');
  assert.equal(c.bucket, 'tracked');
  assert.equal(c.declaresFrontmatter, true);
  assert.equal(c.statusValue, 'Verification');
  assert.equal(c.status, 'Verification');
  // The LINE is kept whole. The publisher copies the source's status line
  // verbatim, so the audit quoting it back is what lets a human diff a claim
  // against the file it came from.
  assert.equal(c.statusLine, 'status: Verification');
});

test('classifyPlan puts frontmatter-without-status in its own bucket, not in either of the others', () => {
  const c = audit.classifyPlan('---\nschema: ultra-plan/v1\nrunner_contract: true\n---\n\n# Plan\n');
  assert.equal(c.bucket, 'tracked-no-status', 'a fence with no status: line is a third case');
  assert.equal(c.declaresFrontmatter, true);
  assert.equal(c.status, null);
  // It must not be folded into `untracked`: that bucket means the publisher
  // invented a default, and this file is not what produced the mirror's status.
  assert.notEqual(c.bucket, 'untracked');
  assert.notEqual(c.bucket, 'tracked');
});

test('classifyPlan strips a trailing # comment from the status for grouping only', () => {
  const c = audit.classifyPlan('---\nstatus: Draft   # published at Draft on purpose\n---\n\n# Plan\n');
  assert.equal(c.bucket, 'tracked');
  // Grouping key: the comment is NOT part of the status, so a plan annotated
  // with a comment counts in the same Draft row as an uncommented one.
  assert.equal(c.status, 'Draft');
  // Verbatim value: the comment IS part of the source line and is preserved,
  // because the whole line is what the publisher copies through.
  assert.equal(c.statusValue, 'Draft   # published at Draft on purpose');
  assert.equal(c.statusLine, 'status: Draft   # published at Draft on purpose');
});

test('classifyPlan only reads a status line inside the frontmatter fence', () => {
  // A `status:` in the BODY is prose, not frontmatter. Reading it would invent a
  // lifecycle claim for a plan that declares none.
  const c = audit.classifyPlan('---\nschema: ultra-plan/v1\n---\n\n# Plan\n\nstatus: Complete\n');
  assert.equal(c.bucket, 'tracked-no-status');
  assert.equal(c.status, null);
});

test('classifyPlan does not treat a horizontal rule later in the file as a fence', () => {
  const c = audit.classifyPlan('# Plan\n\nsome text\n\n---\n\nmore text\n');
  assert.equal(c.declaresFrontmatter, false, 'only the FIRST line can open a fence');
  assert.equal(c.bucket, 'untracked');
});

test('classifyPlan reads a status out of a frontmatter fence that is never closed', () => {
  // A plan with broken frontmatter is still a plan that has to be counted, and
  // silently reporting it as untracked would be inventing a cause for it.
  const c = audit.classifyPlan('---\nschema: ultra-plan/v1\nstatus: Open\n\n# Plan\n');
  assert.equal(c.bucket, 'tracked');
  assert.equal(c.status, 'Open');
});

// ---------- aggregate: the whole registry ----------

const MIXED = {
  // no frontmatter at all
  '2026-01-01-a.md': '# A\n\nno frontmatter\n',
  '2026-01-02-b.md': '# B\n\nalso none\n',
  // frontmatter + status
  '2026-01-03-c.md': '---\nschema: ultra-plan/v1\nstatus: Complete\n---\n\n# C\n',
  '2026-01-04-d.md': '---\nschema: ultra-plan/v1\nstatus: Draft  # not measured yet\n---\n\n# D\n',
  '2026-01-05-e.md': '---\nschema: ultra-plan/v1\nstatus: Draft\n---\n\n# E\n',
  // frontmatter, NO status
  '2026-01-06-f.md': '---\nschema: ultra-plan/v1\n---\n\n# F\n',
};

test('audit splits the registry into untracked, tracked and tracked-no-status, and the three sum to the total', () => {
  const f = fixture('split', MIXED);
  const r = audit.auditPlans(loadRegistry(f.config));
  assert.equal(r.total, 6);
  assert.equal(r.untracked, 2);
  assert.equal(r.tracked, 3);
  assert.equal(r.trackedNoStatus, 1);
  assert.equal(
    r.untracked + r.trackedNoStatus + r.tracked,
    r.total,
    'every enumerated plan must land in exactly one bucket, or the tally lies',
  );
  f.cleanup();
});

test('audit groups the tracked plans by status, with the comment stripped', () => {
  const f = fixture('group', MIXED);
  const r = audit.auditPlans(loadRegistry(f.config));
  assert.deepEqual(r.byStatus, { Complete: 1, Draft: 2 },
    'both Draft plans — annotated and bare — must count in one Draft row');
  f.cleanup();
});

test('audit records the verbatim status line of every tracked plan, for a human to check', () => {
  const f = fixture('verbatim', MIXED);
  const r = audit.auditPlans(loadRegistry(f.config));
  const d = r.trackedPlans.find((p) => path.basename(p.path) === '2026-01-04-d.md');
  assert.equal(d.statusLine, 'status: Draft  # not measured yet');
  assert.equal(d.status, 'Draft');
  assert.equal(d.project, 'demo');
  f.cleanup();
});

// ---------- CLI ----------

test('the CLI prints both bucket labels, a per-status breakdown, and exits 0', () => {
  const f = fixture('cli', MIXED);
  const r = run([], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  // skip_if for T5 greps for this exact token.
  assert.ok(r.stdout.includes('untracked (no frontmatter)'), `stdout: ${r.stdout}`);
  assert.ok(r.stdout.includes('tracked (declares status)'), `stdout: ${r.stdout}`);
  assert.ok(/tracked, frontmatter but NO status line:\s*1/.test(r.stdout), `stdout: ${r.stdout}`);
  assert.ok(/Complete\s+1/.test(r.stdout), `stdout: ${r.stdout}`);
  assert.ok(/Draft\s+2/.test(r.stdout), `stdout: ${r.stdout}`);
  f.cleanup();
});

test('the CLI says in words that an untracked mirror status is a publisher fallback, not a claim', () => {
  const f = fixture('wording', MIXED);
  const r = run([], f);
  const lower = r.stdout.toLowerCase();
  assert.ok(lower.includes('fallback'), `the report must name the fallback:\n${r.stdout}`);
  assert.ok(lower.includes('says nothing about the work'),
    `the report must state that the value says nothing about the work:\n${r.stdout}`);
  f.cleanup();
});

test('the CLI calls out a non-zero tracked-but-no-status count as its own case and names the plans', () => {
  const f = fixture('callout', MIXED);
  const r = run([], f);
  // The figure must be labelled as a distinct case rather than implied by the
  // arithmetic: someone reading only the two bucket lines would otherwise add
  // tracked+untracked to the total and get the right answer by accident.
  assert.ok(/NOT the expected/.test(r.stdout),
    `a non-zero third bucket must be called out as a departure:\n${r.stdout}`);
  assert.ok(r.stdout.includes('2026-01-06-f.md'),
    `the report must name the plans in that bucket:\n${r.stdout}`);
  f.cleanup();
});

test('the CLI reports the expected zero of the third bucket without inventing a callout', () => {
  const f = fixture('third-zero', {
    '2026-01-01-a.md': '# A\n\nno frontmatter\n',
    '2026-01-02-b.md': '---\nschema: ultra-plan/v1\nstatus: Complete\n---\n\n# B\n',
  });
  const r = run([], f);
  assert.ok(/tracked, frontmatter but NO status line: 0/.test(r.stdout), `stdout: ${r.stdout}`);
  assert.ok(/is the expected/.test(r.stdout), `stdout: ${r.stdout}`);
  assert.ok(!/NOT the expected/.test(r.stdout), 'a zero must not be dressed up as a finding');
  f.cleanup();
});

test('the CLI exits 0 on an empty registry instead of treating it as an error', () => {
  const f = fixture('empty', {});
  const r = run([], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(/0 total|total plans: 0/.test(r.stdout), `stdout: ${r.stdout}`);
  f.cleanup();
});

test('the CLI exits 0 even when the registry cannot be loaded, because it is a report and never a gate', () => {
  const f = fixture('badcfg', MIXED);
  const r = run([], f, { PLAN_PUBLISH_CONFIG: path.join(f.base, 'nope.json') });
  assert.equal(r.code, 0, `a missing config is a fact about the world, not a failure:\n${r.stdout}\n${r.stderr}`);
  assert.ok(/nope\.json/.test(`${r.stdout}${r.stderr}`), 'the error must name the path that failed');
  f.cleanup();
});

test('the CLI exits 0 on a plan whose text is unreadable garbage rather than dropping it', () => {
  const f = fixture('garbage', MIXED);
  f.write('2026-01-07-g.md', 'not markdown at all, no fence, no heading\n');
  const r = run([], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(/total plans: 7/.test(r.stdout), `stdout: ${r.stdout}`);
  assert.ok(/untracked \(no frontmatter\): 3/.test(r.stdout), `stdout: ${r.stdout}`);
  f.cleanup();
});

test('--json emits the same numbers as the text report', () => {
  const f = fixture('json', MIXED);
  const r = run(['--json'], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const data = JSON.parse(r.stdout);
  assert.equal(data.total, 6);
  assert.equal(data.untracked, 2);
  assert.equal(data.tracked, 3);
  assert.equal(data.trackedNoStatus, 1);
  assert.deepEqual(data.byStatus, { Complete: 1, Draft: 2 });
  assert.ok(data.config.endsWith('plans.publish.json'), 'the JSON must name the registry it measured');
  // T6 quotes the nine explicit Draft plans by source path, so the paths have to
  // be in the JSON and not only implied by the text table.
  const drafts = data.trackedPlans.filter((p) => p.status === 'Draft').map((p) => path.basename(p.path)).sort();
  assert.deepEqual(drafts, ['2026-01-04-d.md', '2026-01-05-e.md']);
  f.cleanup();
});

test('--help exits 0 and documents the flags', () => {
  const f = fixture('help', MIXED);
  const r = run(['--help'], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(r.stdout.includes('--json'), `stdout: ${r.stdout}`);
  f.cleanup();
});

test('the CLI never reads the real vault: it runs entirely off PLAN_PUBLISH_CONFIG', () => {
  // The fake registry's vault is a temp dir. If the audit ignored
  // PLAN_PUBLISH_CONFIG it would have measured the real 271 plans and these
  // numbers would be 6 in name only.
  const f = fixture('injection', MIXED);
  const r = run([], f);
  assert.ok(r.stdout.includes(f.vault), `the report must name the vault it read from:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('/home/belajarcarabelajar/Dokumen/Obsidian Vault'),
    'the report must come from the injected config, not the real registry');
  f.cleanup();
});
