import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeCmd, stableId, buildCorpus, balanceOf } from './spike-skipif-corpus.mjs';
import { classifySpikeSkipIf } from './spike-skipif-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'spike-skipif-corpus.mjs');

test('normalizeCmd collapses whitespace but never reorders segments', () => {
  assert.equal(normalizeCmd('  bun   test    scripts/  '), 'bun test scripts/');
  // Collapsing must not merge two different commands. If it did, two distinct
  // actions would collapse into one row and the agreement metric in T4 would
  // silently gain a point it never earned.
  assert.notEqual(normalizeCmd('git commit -m "a"'), normalizeCmd('git commit -am "a"'));
});

test('normalizeCmd turns every non-string or blank input into empty', () => {
  for (const bad of ['', '   ', undefined, null, 42, {}, []]) {
    assert.equal(normalizeCmd(bad), '', `input ${JSON.stringify(bad)} should normalize to empty`);
  }
});

test('stableId is deterministic and content-addressed', () => {
  const a = stableId('bun test scripts/');
  assert.equal(a, stableId('bun test scripts/'));
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, stableId('git push origin main'));
});

test('buildCorpus dedupes on the normalized command and keeps first source', () => {
  const rows = [
    { cmd: 'bun test scripts/', source: 'a.md' },
    { cmd: 'bun  test  scripts/', source: 'b.md' },
    { cmd: 'git push origin main', source: 'c.md' },
    { cmd: '', source: 'd.md' },
  ];
  const corpus = buildCorpus(rows);
  assert.equal(corpus.length, 2, 'the blank command must be dropped');
  const bun = corpus.find((r) => r.cmd === 'bun test scripts/');
  assert.equal(bun.source, 'a.md', 'first source wins so the row is read-order independent');
});

test('buildCorpus attaches the classifySpikeSkipIf label to every row', () => {
  const corpus = buildCorpus([
    { cmd: 'bun test scripts/x.test.mjs', source: 'a.md' },
    { cmd: "grep -q 'Marker' src/x.md", source: 'b.md' },
  ]);
  const labels = corpus.map((r) => r.label).sort();
  assert.deepEqual(labels, ['behavioural', 'loose']);
  // The label must come from the frozen snapshot, not from a copy of it.
  for (const row of corpus) assert.equal(row.label, classifySpikeSkipIf(row.cmd));
});

test('buildCorpus sorts by stable id so a re-run is byte-identical', () => {
  const corpus = buildCorpus([
    { cmd: 'zzz command', source: 'a' },
    { cmd: 'aaa command', source: 'b' },
  ]);
  const ids = corpus.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort());
});

test('balanceOf reports both classes, and the count of rows', () => {
  const corpus = buildCorpus([
    { cmd: 'bun test a', source: 'a' },
    { cmd: 'git status', source: 'b' },
    { cmd: "grep -q 'x' f.md", source: 'c' },
  ]);
  const b = balanceOf(corpus);
  assert.equal(b.total, 3);
  assert.equal(b.behavioural + b.loose, b.total, 'every row must carry exactly one of the two labels');
  assert.ok(b.behavioural > 0 && b.loose > 0);
});

test('balanceOf flags a degenerate corpus so the CLI can refuse it', () => {
  const oneClass = buildCorpus([
    { cmd: 'bun test a', source: 'a' },
    { cmd: 'git status', source: 'b' },
  ]);
  assert.equal(balanceOf(oneClass).degenerate, true, 'a single-class corpus cannot measure calibration');
});

test('the CLI harvests the vault and reports a balanced corpus', () => {
  const r = spawnSync('bun', [CLI, '--stats'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const stats = JSON.parse(r.stdout);
  assert.ok(stats.total >= 150, `only ${stats.total} rows; the spike precondition requires at least 150`);
  assert.equal(stats.degenerate, false, 'the harvested corpus is single-class, so calibration is unmeasurable');
  assert.ok(stats.behavioural > 0 && stats.loose > 0);
});

test('the CLI writes valid JSON, one row per unique command, sorted by id', () => {
  const out = path.join(ROOT, 'spike-out', 'corpus.test.json');
  const r = spawnSync('bun', [CLI, '--out', out], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rows = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(rows.length >= 150);
  assert.equal(new Set(rows.map((x) => x.cmd)).size, rows.length, 'the corpus must contain no duplicate command');
  const ids = rows.map((x) => x.id);
  assert.deepEqual(ids, [...ids].sort(), 'rows must be sorted by id for a reproducible file');
  for (const row of rows) {
    assert.equal(typeof row.id, 'string');
    assert.equal(typeof row.cmd, 'string');
    assert.ok(['behavioural', 'loose'].includes(row.label), `unexpected label ${row.label}`);
    assert.equal(row.label, classifySpikeSkipIf(row.cmd), 'the label must agree with the frozen classifier snapshot');
    assert.equal(typeof row.source, 'string');
    assert.equal(typeof row.project, 'string');
  }
  fs.rmSync(out, { force: true });
});

test('the CLI exits non-zero on a degenerate corpus rather than emitting it', () => {
  // The negative control. T1's E_PRECOND_IMBALANCE guard only means something
  // if it can actually fail, and v1 shipped a 77-row corpus that cleared its
  // size threshold while measuring nothing.
  const r = spawnSync('bun', [CLI, '--min-rows', '100000'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1, 'an unmeetable size precondition must fail closed');
  assert.match(r.stderr, /E_PRECOND/);
});
