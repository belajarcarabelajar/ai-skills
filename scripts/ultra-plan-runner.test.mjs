import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFrontmatter,
  parseUltraPlanYaml,
  topoSort,
  descendants,
  validatePlan,
} from './ultra-plan-runner.mjs';

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
  const { errors } = validatePlan(plan, '# Plan\n### Task T9: x\n');
  assert.ok(errors.some((e) => /mermaid/i.test(e) && /T9/.test(e)));
});
