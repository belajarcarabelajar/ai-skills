import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractFrontmatter,
  parseUltraPlanYaml,
  topoSort,
  descendants,
  validatePlan,
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

const planWith = (tasks) => ({ schema: 'ultra-plan/v1', runner_contract: true, tasks });
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

// A minimal VALID plan: one task, no run[] steps. No run[] means the runner
// reports NEEDS-AGENT and executes nothing, which is exactly what lets these
// tests assert "the DAG was reached" versus "the gate stopped it" without any
// task command being able to fail for an unrelated reason.
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
