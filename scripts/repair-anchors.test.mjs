// scripts/repair-anchors.test.mjs
//
// Tests for the anchor repair tool. The core logic is in unquoteForms,
// planChunk, applyPlan, and rewrite.
//
// applyPlan and planChunk resolve the quoted file against a root list, so these
// tests point them at a temp fixture root instead of the real vault. Fixture
// lines: L1 and L2 both carry `ai-skills`, L3 carries `name`.
//
// The key invariants being tested:
// 1. unquoteForms generates candidate renderings (raw, unescaped, stripped)
// 2. planChunk correctly classifies repairs into T1/T2/T3/T4
// 3. applyPlan rewrites anchors and proves the result
// 4. rewrite applies plans to chunks

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { unquoteForms, planChunk, applyPlan, rewrite } from './repair-anchors.mjs';

const FIXTURE_PACKAGE_JSON = 'ai-skills\n  "name": "ai-skills",\n  "name": "again"\n';

// A temp root holding the fixture `package.json` the file-resolving paths use.
function fixtureRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-anchors-root-'));
  fs.writeFileSync(path.join(dir, 'package.json'), FIXTURE_PACKAGE_JSON);
  return dir;
}

const cleanup = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};

// ---------- unquoteForms ----------

test('unquoteForms returns raw string when no changes needed', () => {
  const forms = unquoteForms('simple quote');
  assert.ok(forms.includes('simple quote'));
});

test('unquoteForms unescapes escaped quotes', () => {
  const forms = unquoteForms('she said \\"hello\\" world');
  assert.ok(forms.some((f) => f.includes('she said "hello" world')));
});

test('unquoteForms strips wrapping quotes', () => {
  const forms = unquoteForms('"wrapped quote"');
  assert.ok(forms.some((f) => f === 'wrapped quote'));
});

test('unquoteForms strips backticks', () => {
  const forms = unquoteForms('`code span`');
  assert.ok(forms.some((f) => f === 'code span'));
});

test('unquoteForms keeps the raw form but drops short unquoted variants', () => {
  // The raw string is always a candidate; only the derived, unquoted variant is
  // subject to the length floor. A two-char variant adds nothing a substring
  // search wants, but dropping the raw would break short legitimate quotes.
  assert.deepEqual(unquoteForms('ab'), ['ab']);
  assert.deepEqual(unquoteForms('"ab"'), ['"ab"']);
});

test('unquoteForms handles complex escaping', () => {
  const forms = unquoteForms('"she said \\"hi\\""');
  assert.ok(forms.some((f) => f.includes('she said "hi"')));
});

// ---------- applyPlan ----------

test('applyPlan returns null for T4 tier', () => {
  const s = '[file.md:L1] quote';
  const pl = { tier: 'T4', k: 0, from: 1, file: 'file.md', quoted: 'quote' };
  const result = applyPlan(s, pl);
  assert.equal(result, null);
});

test('applyPlan returns null when anchor index is out of range', () => {
  const s = '[file.md:L1] quote';
  const pl = { tier: 'T1', k: 5, to: 2 };
  const result = applyPlan(s, pl);
  assert.equal(result, null);
});

test('applyPlan T1 changes line number only', () => {
  // T1: quote is verbatim but at wrong line — change line number only
  const root = fixtureRoot();
  const s = '[package.json:L1] ai-skills';
  const pl = { tier: 'T1', k: 0, to: 2, from: 1, file: 'package.json', quoted: 'ai-skills' };
  const result = applyPlan(s, pl, { roots: [root] });
  assert.ok(result !== null);
  assert.ok(result.includes(':L00002]'));
  assert.ok(result.includes('ai-skills'));
  cleanup(root);
});

test('applyPlan T1 preserves quoted text exactly', () => {
  const root = fixtureRoot();
  const s = '[package.json:L1] "ai-skills"';
  const pl = { tier: 'T1', k: 0, to: 2, from: 1, file: 'package.json', quoted: '"ai-skills"' };
  const result = applyPlan(s, pl, { roots: [root] });
  assert.ok(result !== null);
  assert.ok(result.includes('"ai-skills"'));
  cleanup(root);
});

test('applyPlan proves the result — rejects unproven repairs', () => {
  // The new line does not contain the quote, so the repair must be refused
  // rather than written.
  const root = fixtureRoot();
  const s = '[package.json:L1] definitely not on line 2';
  const pl = { tier: 'T1', k: 0, to: 2, from: 1, file: 'package.json', quoted: 'definitely not on line 2' };
  const result = applyPlan(s, pl, { roots: [root] });
  assert.equal(result, null);
  cleanup(root);
});

test('applyPlan handles multiple anchors in string', () => {
  const root = fixtureRoot();
  const s = '[package.json:L1] ai-skills [package.json:L2] name';
  const pl = { tier: 'T1', k: 1, to: 3, from: 2, file: 'package.json', quoted: 'name' };
  const result = applyPlan(s, pl, { roots: [root] });
  assert.ok(result !== null);
  assert.ok(result.includes(':L00003]'));
  cleanup(root);
});

// ---------- rewrite ----------

test('rewrite returns 0 when no plans match', () => {
  const chunk = {
    nodes: [
      { id: 'node-1', rationale: '[package.json:L1] ai-skills' },
    ],
  };
  const plans = [{ tier: 'T4', node: 'node-1', idx: 0, k: 0 }];
  const result = rewrite(chunk, plans, ['T1', 'T2']);
  assert.equal(result, 0);
});

test('rewrite applies T1 plans', () => {
  const root = fixtureRoot();
  const chunk = {
    nodes: [
      { id: 'node-1', rationale: '[package.json:L1] ai-skills' },
    ],
  };
  const plans = [{ tier: 'T1', node: 'node-1', idx: 0, k: 0, to: 2, from: 1, file: 'package.json', quoted: 'ai-skills' }];
  const result = rewrite(chunk, plans, ['T1'], { roots: [root] });
  assert.equal(result, 1);
  assert.ok(chunk.nodes[0].rationale.includes(':L00002]'));
  cleanup(root);
});

test('rewrite handles array rationale', () => {
  const root = fixtureRoot();
  const chunk = {
    nodes: [
      { id: 'node-1', rationale: ['[package.json:L1] ai-skills', '[package.json:L2] name'] },
    ],
  };
  const plans = [{ tier: 'T1', node: 'node-1', idx: 0, k: 0, to: 2, from: 1, file: 'package.json', quoted: 'ai-skills' }];
  const result = rewrite(chunk, plans, ['T1'], { roots: [root] });
  assert.equal(result, 1);
  assert.ok(Array.isArray(chunk.nodes[0].rationale));
  assert.ok(chunk.nodes[0].rationale[0].includes(':L00002]'));
  cleanup(root);
});

test('rewrite skips plans for missing nodes', () => {
  const chunk = {
    nodes: [
      { id: 'node-1', rationale: '[package.json:L1] ai-skills' },
    ],
  };
  const plans = [{ tier: 'T1', node: 'node-999', idx: 0, k: 0, to: 2, from: 1, file: 'package.json', quoted: 'ai-skills' }];
  const result = rewrite(chunk, plans, ['T1']);
  assert.equal(result, 0);
});

test('rewrite skips unproven plans', () => {
  const root = fixtureRoot();
  const chunk = {
    nodes: [
      { id: 'node-1', rationale: '[package.json:L1] not on line 2' },
    ],
  };
  const plans = [{ tier: 'T1', node: 'node-1', idx: 0, k: 0, to: 2, from: 1, file: 'package.json', quoted: 'not on line 2' }];
  const result = rewrite(chunk, plans, ['T1'], { roots: [root] });
  assert.equal(result, 0);
  // Rationale unchanged
  assert.ok(chunk.nodes[0].rationale.includes(':L1]'));
  cleanup(root);
});

// ---------- planChunk ----------

test('planChunk returns empty plans for clean chunk', () => {
  const root = fixtureRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-anchors-chunks-'));
  const chunk = {
    nodes: [
      { id: 'node-1', source_file: 'package.json', source_location: 'L2', rationale: '[package.json:L2] ai-skills' },
    ],
    links: [],
  };
  fs.writeFileSync(path.join(dir, 'chunk-999.json'), JSON.stringify(chunk));
  const { plans } = planChunk('chunk-999.json', { dir, roots: [root] });
  assert.deepEqual(plans, []);
  cleanup(dir, root);
});

test('planChunk classifies T4 for missing files', () => {
  const root = fixtureRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-anchors-chunks-'));
  const chunk = {
    nodes: [
      {
        id: 'node-1',
        source_file: 'missing.md',
        source_location: 'L1',
        rationale: '[missing.md:L1] a quote long enough to be considered',
      },
    ],
    links: [],
  };
  fs.writeFileSync(path.join(dir, 'chunk-999.json'), JSON.stringify(chunk));
  const { plans } = planChunk('chunk-999.json', { dir, roots: [root] });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].tier, 'T4');
  assert.equal(plans[0].why, 'no file');
  cleanup(dir, root);
});
