import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkRunnerContract, keyPaths } from './check-runner-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'check-runner-contract.mjs');

test('keyPaths drops array indices so a bracket path compares equal', () => {
  const found = [...keyPaths({ tasks: [{ id: 'T1', run: [{ cmd: 'x' }] }] })];
  assert.ok(found.includes('tasks.id'));
  assert.ok(found.includes('tasks.run.cmd'));
  assert.ok(!found.some((p) => /\.\d+\./.test(p)), found.join(' | '));
});

test('the repository as it stands satisfies the runner contract', () => {
  const { problems, total } = checkRunnerContract();
  assert.deepEqual(problems, []);
  assert.ok(total > 0, 'the contract key list is empty, so this test proves nothing');
});

test('the CLI exits 0 and names the key count on a clean tree', () => {
  const r = spawnSync('bun', [CLI], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all \d+ keys the runner reads/);
});

test('the CLI exits 1 when a documented key disappears from the template', () => {
  // The negative control. A check that cannot fail is not a check, and the
  // first draft of this one grepped for key names in prose and therefore passed
  // a template whose `run:` had been renamed.
  const tpl = path.join(ROOT, 'templates', 'implementation-plan-template.md');
  const original = fs.readFileSync(tpl, 'utf8');
  try {
    fs.writeFileSync(tpl, original.replace(/^(\s*)run:/gm, '$1disabled_run:'));
    const r = spawnSync('bun', [CLI], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 1, 'renaming run: in the template must fail the check');
    assert.match(r.stderr, /tasks\.run\b/);
  } finally {
    fs.writeFileSync(tpl, original);
  }
  // And the tree is clean again, which is the half that matters: a negative
  // control that leaves the repo modified proves nothing about the next run.
  const after = spawnSync('bun', [CLI], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(after.status, 0, after.stdout + after.stderr);
});

test('the CLI stays fast enough to use as a plan skip_if', () => {
  // It exists as a separate entry point precisely because validate-skill.mjs
  // renders Mermaid through a headless browser. A plan step that shells into
  // that on every re-run times out, which is what happened when skip_if grepped
  // validate-skill's output for a literal key count.
  const started = Date.now();
  const r = spawnSync('bun', [CLI], { cwd: ROOT, encoding: 'utf8' });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 0);
  assert.ok(elapsed < 15_000, `check took ${elapsed}ms, too slow to sit in a skip_if`);
});
