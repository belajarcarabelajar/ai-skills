import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUBAGENT_CONTRACT_TERMS,
  SNIPPET_CONTRACTS,
  REQUIRED_SNIPPETS,
  TINYFISH_LADDER_NEED,
  BANNED_RUNTIME_SNIPPETS,
  RENDERER_OPEN_AWK,
  RENDERER_CLOSE_AWK,
  findMissingTerms,
  checkSnippetContract,
  checkTinyFishLadder,
  checkBannedRuntime,
  hasStrictMermaidFence,
  extractMermaidBlocksStrict,
} from './validate-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = fs.readFileSync(path.join(ROOT, 'scripts', 'validate-skill.mjs'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'scripts', 'render-diagrams.sh'), 'utf8');
const readSnip = (n) => fs.readFileSync(path.join(ROOT, 'snippets', n), 'utf8');

// --- Gap 2: the review snippet is a first-class contract --------------------

test('every manifest source has a snippet contract entry (no orphan snippets)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'snippets.manifest.json'), 'utf8'));
  const sources = manifest.snippets.map((e) => path.basename(e.source));
  for (const src of sources) {
    assert.ok(
      SNIPPET_CONTRACTS[src],
      `${src} is tracked in snippets.manifest.json but has no entry in SNIPPET_CONTRACTS — it bypasses all content checks`,
    );
  }
});

test('every required snippet is tracked in the manifest (or it never reaches the DB)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'snippets.manifest.json'), 'utf8'));
  const sources = manifest.snippets.map((e) => e.source);
  for (const snip of REQUIRED_SNIPPETS) {
    assert.ok(sources.includes(`snippets/${snip}`), `${snip} has a contract but is not tracked in the manifest`);
  }
});

test('orkestrasi-pr-review.md is under contract', () => {
  assert.ok(REQUIRED_SNIPPETS.includes('orkestrasi-pr-review.md'));
  assert.ok(SNIPPET_CONTRACTS['orkestrasi-pr-review.md'].length > 0);
});

test('all live snippets pass their contract, ladder, and runtime checks', () => {
  assert.ok(REQUIRED_SNIPPETS.length >= 4, 'expected at least the four trigger snippets');
  for (const [snip, extra] of Object.entries(SNIPPET_CONTRACTS)) {
    const body = readSnip(snip);
    assert.deepEqual(checkSnippetContract(body, extra), [], `${snip} missing contract terms`);
    assert.deepEqual(checkTinyFishLadder(body), [], `${snip} missing TinyFish ladder terms`);
    assert.deepEqual(checkBannedRuntime(body), [], `${snip} uses a prohibited runtime`);
  }
});

test('snippet checks fail when a term is deleted (negative controls)', () => {
  const body = readSnip('orkestrasi-pr-review.md');
  const extra = SNIPPET_CONTRACTS['orkestrasi-pr-review.md'];
  // Remove one shared term and one phase term; each must be reported.
  const withoutShared = body.replaceAll('TASK-CHUNKING', 'XXXXXXXX');
  assert.ok(checkSnippetContract(withoutShared, extra).includes('TASK-CHUNKING'));
  const phaseTerm = extra.find((t) => body.includes(t));
  assert.ok(phaseTerm, 'phase-term list names nothing the snippet contains, so this test proves nothing');
  const withoutPhase = body.replaceAll(phaseTerm, 'YYYYYYYY');
  assert.ok(checkSnippetContract(withoutPhase, extra).includes(phaseTerm));
  // Ladder + runtime negatives.
  assert.ok(checkTinyFishLadder(body.replaceAll('fetch_content', 'ZZZZZZ')).includes('fetch_content'));
  const withBanned = `${body}\nrun: npm test\n`;
  assert.ok(checkBannedRuntime(withBanned).includes('npm test'));
});

// --- Gap 3: validator and renderer agree on what a fence looks like ---------

test('render-diagrams.sh still uses the strict awk fence both sides assume', () => {
  assert.ok(RENDERER.includes('/^```mermaid[ \\t]*$/'), 'renderer open pattern changed — update validate-lib.mjs to match');
  assert.ok(RENDERER.includes('/^```[ \\t]*$/'), 'renderer close pattern changed — update validate-lib.mjs to match');
  assert.equal(RENDERER_OPEN_AWK, '/^```mermaid[ \\t]*$/');
  assert.equal(RENDERER_CLOSE_AWK, '/^```[ \\t]*$/');
});

test('strict extractor mirrors the awk semantics', () => {
  const exact = 'before\n```mermaid\nflowchart TB\n A-->B\n```\nafter';
  assert.deepEqual(extractMermaidBlocksStrict(exact), ['flowchart TB\n A-->B']);
  assert.ok(hasStrictMermaidFence(exact));

  const trailingSpaces = '```mermaid   \nX\n```  \n';
  assert.ok(hasStrictMermaidFence(trailingSpaces));
  assert.deepEqual(extractMermaidBlocksStrict(trailingSpaces), ['X']);

  // A fence the loose /```mermaid/ regex accepted but awk never extracts.
  const withConfig = '```mermaid {config}\nX\n```\n';
  assert.ok(!hasStrictMermaidFence(withConfig), '```mermaid {extra} must not count: the renderer skips it');
  assert.deepEqual(extractMermaidBlocksStrict(withConfig), []);

  // Unclosed block: awk never flushes buf, so neither do we.
  assert.deepEqual(extractMermaidBlocksStrict('```mermaid\nnever closed'), []);
  // Two blocks stay separate.
  const two = '```mermaid\nA\n```\ntext\n```mermaid\nB\n```\n';
  assert.deepEqual(extractMermaidBlocksStrict(two), ['A', 'B']);
});

test('validator uses the strict helpers, not a loose regex', () => {
  assert.match(VALIDATOR, /from '\.\/validate-lib\.mjs'/);
  assert.match(VALIDATOR, /hasStrictMermaidFence/);
  assert.match(VALIDATOR, /extractMermaidBlocksStrict/);
  assert.doesNotMatch(VALIDATOR, /\/```mermaid\[\\s\\S\]/);
  assert.doesNotMatch(VALIDATOR, /blockRe = \/```mermaid/);
});

test('every mermaid-required template passes the strict fence check', () => {
  const templates = [
    'implementation-plan-template.md',
    'spike-report-template.md',
    'systematic-debugging-log-template.md',
    'verification-checklist-template.md',
    'adr-template.md',
    'subagent-contract-template.md',
    'code-review-template.md',
    'follow-up-injection-template.md',
    'pull-request-template.md',
    'pr-review-template.md',
  ];
  for (const tmpl of templates) {
    const content = fs.readFileSync(path.join(ROOT, 'templates', tmpl), 'utf8');
    assert.ok(hasStrictMermaidFence(content), `${tmpl} has no strict fence the renderer would extract`);
    assert.ok(extractMermaidBlocksStrict(content).length > 0, `${tmpl} yields zero strict blocks`);
  }
});

// --- Gap 1: validator logic is pinned without running the minutes-long gate --

test('validator imports contracts from the lib instead of redefining them', () => {
  assert.match(VALIDATOR, /SNIPPET_CONTRACTS as snippetContracts/);
  assert.match(VALIDATOR, /SUBAGENT_CONTRACT_TERMS as subagentContractTerms/);
  assert.match(VALIDATOR, /TINYFISH_LADDER_NEED/);
  assert.match(VALIDATOR, /BANNED_RUNTIME_SNIPPETS/);
  assert.doesNotMatch(VALIDATOR, /const subagentContractTerms = \[/);
  assert.doesNotMatch(VALIDATOR, /const snippetContracts = \{/);
});

test('findMissingTerms is substring-exact and order-stable', () => {
  assert.deepEqual(findMissingTerms('aaa bbb', ['aaa', 'missing']), ['missing']);
  assert.deepEqual(findMissingTerms('', ['x']), ['x']);
});
