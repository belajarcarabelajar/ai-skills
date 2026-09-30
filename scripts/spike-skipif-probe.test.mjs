import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, verdictFor, PRICE_PER_MTOK } from './spike-skipif-probe.mjs';
import { classifySkipIf } from './ultra-plan-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('summarize scores a corpus against the production classifier', () => {
  const corpus = [
    { id: 'a', cmd: 'bun test x.test.mjs', label: 'behavioural' },
    { id: 'b', cmd: "grep -q 'M' f.md", label: 'loose' },
    { id: 'c', cmd: 'test -f f.md', label: 'loose' },
  ];
  // Two agree, one disagrees: Jev calls `test -f f.md` behavioural.
  const results = [
    { id: 'a', verdict: { predicted: 'behavioural', correct: true, p: 0.9 } },
    { id: 'b', verdict: { predicted: 'loose', correct: true, p: 0.8 } },
    { id: 'c', verdict: { predicted: 'behavioural', correct: false, p: 0.6 } },
  ];
  const s = summarize(corpus, results);
  assert.equal(s.total, 3);
  assert.equal(s.agree, 2);
  assert.ok(Math.abs(s.agreement - 2 / 3) < 1e-9);
  assert.equal(s.confusion.trueLoosePredBehavioural, 1);
  assert.equal(s.confusion.agree, 2);
  assert.equal(s.disagreements.length, 1);
  assert.equal(s.disagreements[0].id, 'c');
  // The disagreement must carry enough for T5 to adjudicate it without re-running.
  assert.equal(s.disagreements[0].cmd, 'test -f f.md');
  assert.equal(s.disagreements[0].reference, 'loose');
  assert.equal(s.disagreements[0].predicted, 'behavioural');
});

test('summarize refuses a result whose id is not in the corpus', () => {
  // A silently dropped or renamed row would inflate the agreement rate by
  // shrinking the denominator, which is exactly the failure this metric exists
  // to detect.
  assert.throws(
    () => summarize([{ id: 'a', cmd: 'bun test x', label: 'behavioural' }], [{ id: 'zzz', verdict: { predicted: 'loose', correct: true, p: 1 } }]),
    /no corpus row/,
  );
});

test('summarize recomputes cost from the API-reported token usage', () => {
  const corpus = [
    { id: 'a', cmd: 'bun test x', label: 'behavioural' },
    { id: 'b', cmd: "grep -q 'M' f", label: 'loose' },
  ];
  const results = [
    { id: 'a', verdict: { predicted: 'behavioural', correct: true, p: 1 }, usage: { input_tokens: 1_000_000 } },
    { id: 'b', verdict: { predicted: 'loose', correct: true, p: 1 }, usage: { input_tokens: 1_000_000 } },
  ];
  const s = summarize(corpus, results, { latency: [100, 200] });
  // Two million input tokens at $0.042 per million is $0.084.
  assert.ok(Math.abs(s.cost.recomputedUsd - 0.084) < 1e-9, `got ${s.cost.recomputedUsd}`);
  assert.equal(s.cost.apiReportedInputTokens, 2_000_000);
  assert.equal(s.latency.meanMs, 150);
  assert.equal(s.latency.p95Ms, 200);
  assert.equal(PRICE_PER_MTOK, 0.042);
});

test('summarize reports the price it used so a price change is visible', () => {
  const s = summarize(
    [
      { id: 'a', cmd: 'bun test x', label: 'behavioural' },
      { id: 'b', cmd: "grep -q 'M' f", label: 'loose' },
    ],
    [
      { id: 'a', verdict: { predicted: 'behavioural', correct: true, p: 1 }, usage: { input_tokens: 100 } },
      { id: 'b', verdict: { predicted: 'loose', correct: true, p: 1 }, usage: { input_tokens: 100 } },
    ],
  );
  assert.equal(s.cost.pricePerMtokUsd, PRICE_PER_MTOK);
  assert.match(s.cost.basis, /vendor/i, 'the price is a published figure, not a measured one');
});

test('verdictFor applies the plan gate exactly as written', () => {
  const ok = { total: 200, agreement: 0.86, ece: 0.09, regexWrongCases: 1 };
  assert.equal(verdictFor(ok).verdict, 'gate passes', JSON.stringify(verdictFor(ok)));

  const lowAgreement = { ...ok, agreement: 0.74 };
  assert.equal(verdictFor(lowAgreement).verdict, 'gate fails');

  const badEce = { ...ok, ece: 0.21 };
  assert.equal(verdictFor(badEce).verdict, 'gate fails');

  // The condition that matters: high agreement with no case where the regex is
  // wrong is not a pass. Imitating a correct rule is not a reason to add a
  // network call.
  const noRegexWin = { ...ok, regexWrongCases: 0 };
  const v = verdictFor(noRegexWin);
  assert.equal(v.verdict, 'gate fails');
  assert.match(v.reason, /regex/i);

  const middling = { total: 200, agreement: 0.80, ece: 0.15, regexWrongCases: 1 };
  assert.equal(verdictFor(middling).verdict, 'insufficient evidence');
});

test('verdictFor refuses to rule on a corpus too small to rule on', () => {
  const tiny = { total: 12, agreement: 0.99, ece: 0.01, regexWrongCases: 3 };
  const v = verdictFor(tiny);
  assert.equal(v.verdict, 'insufficient evidence');
  assert.match(v.reason, /sample/i);
});

test('the probe replays the committed cassette and reproduces the committed scores', async () => {
  // T4 Step 3. Replay must be byte-identical to record, otherwise the probe
  // has a determinism bug and its numbers mean nothing.
  const scored = path.join(ROOT, 'spike-out', 'two-class.json');
  if (!fs.existsSync(scored)) {
    // Nothing recorded yet: the probe has not run. Skipping is honest; failing
    // would break the suite before the first probe run.
    return;
  }
  const saved = JSON.parse(fs.readFileSync(scored, 'utf8'));
  const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'spike-out', 'corpus.json'), 'utf8'));
  const replayed = await runReplay(corpus);
  // The written report spreads the summary at the top level rather than nesting
  // it, so both sides are read through the same accessor.
  assert.equal(replayed.summarize.agreement, saved.agreement);
  assert.equal(replayed.summarize.ece, saved.ece);
  assert.equal(replayed.summarize.brier, saved.brier);
  assert.equal(replayed.summarize.confusion.agree, saved.confusion.agree);
  assert.deepEqual(replayed.summarize.disagreements.map((d) => d.id), saved.disagreements.map((d) => d.id));
  assert.equal(replayed.summarize.verdict.verdict, saved.verdict.verdict);
});

test('every reference label agrees with the production classifier', () => {
  const corpusFile = path.join(ROOT, 'spike-out', 'corpus.json');
  if (!fs.existsSync(corpusFile)) return;
  const corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
  for (const row of corpus) {
    assert.equal(row.label, classifySkipIf(row.cmd), `stale label on ${row.cmd}`);
  }
});

async function runReplay(corpus) {
  const { runProbe } = await import('./spike-skipif-probe.mjs');
  return runProbe({ corpus, mode: 'replay', out: null });
}
