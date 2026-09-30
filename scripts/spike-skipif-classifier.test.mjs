// T1 — the drift lock that makes the freeze durable.
//
// The Jev decision-gate spike in
// `docs/code-plan/spikes/2026-09-30-jev-decision-gate-spike-report.md` is
// COMPLETE and published. Its headline number — agreement 0.995, ECE 0.011,
// Brier 0.005, $0.004129 against jev-1.13.0 — was measured with a specific
// `classifySkipIf` in `scripts/ultra-plan-runner.mjs`.
//
// `classifySkipIf` is production code and is about to change: it will gain
// `sentinel` and `unknown` return values and widen `FILE_PROBE`. Those are the
// right changes, and each of them makes rows in `spike-out/corpus.json` stale.
// When that happens `summarize()` throws `stale label` and the published 0.995
// stops being reproducible.
//
// So the classifier is snapshotted in `spike-skipif-classifier.mjs` and the
// spike imports the snapshot, not the live function. This file is what notices
// if that ever stops being true. A comment is not a guard; these assertions are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  classifySpikeSkipIf,
  SPIKE_EVIDENCE_COMMAND,
  SPIKE_FILE_PROBE,
  SPIKE_CLASSIFIER_FROZEN_ON,
  SPIKE_CORPUS_PATH,
  SPIKE_SCORED_PATH,
} from './spike-skipif-classifier.mjs';

// The literals as they stand in `scripts/ultra-plan-runner.mjs` on 2026-09-30,
// kept here as the independent copy the snapshot is compared against. If either
// side is edited, one of the two assertions below stops holding.
const EXPECTED_EVIDENCE_COMMAND_SOURCE =
  '/\\b(bun|node|npm|pnpm|yarn|deno|python3?|pytest|go|cargo|make|cmake|git|systemctl|curl|docker|tsc|eslint|vitest|jest|ruff|mypy|gradle|mvn)\\b/';
const EXPECTED_FILE_PROBE_SOURCE =
  '/(^|[\\s;&|(])(grep|egrep|rg|cat|head|tail|ls|find|wc|test)\\b/';

test('a tool that must succeed first is behavioural', () => {
  // The rule as written: a tool invocation qualifies even when a grep filters
  // its output, because the tool has to pass before the grep is ever read.
  assert.equal(
    classifySpikeSkipIf("bun test a.test.ts 2>&1 | grep -q 'passes'"),
    'behavioural',
    'a test runner piped into grep is still a behavioural check — the grep is not the assertion',
  );
  assert.equal(classifySpikeSkipIf('git status --porcelain'), 'behavioural');
  assert.equal(classifySpikeSkipIf('bun run ci'), 'behavioural');
});

test('a bare file probe is loose', () => {
  for (const cmd of ["grep -q 'marker' file.md", 'test -f out.txt', 'ls dist/']) {
    assert.equal(classifySpikeSkipIf(cmd), 'loose', `${cmd} reads a file and asserts nothing ran`);
  }
});

test('blank and non-string input is empty', () => {
  for (const bad of ['', '   ', undefined, null, 42, {}, []]) {
    assert.equal(classifySpikeSkipIf(bad), 'empty', `input ${JSON.stringify(bad)} should be empty`);
  }
});

test('the frozen regex sources are byte-identical to the literals they were copied from', () => {
  // `source` omits the delimiters and `flags` is a separate field, so both are
  // reassembled here to reconstruct the literal exactly as it was written.
  // Comparing the body alone would pass on a pattern carrying a stray `g` flag,
  // and a stateful regex would silently make the label non-deterministic.
  assert.equal(
    `/${SPIKE_EVIDENCE_COMMAND.source}/${SPIKE_EVIDENCE_COMMAND.flags}`,
    EXPECTED_EVIDENCE_COMMAND_SOURCE,
    'EVIDENCE_COMMAND in the snapshot no longer matches the one the 0.995 was measured against',
  );
  assert.equal(
    `/${SPIKE_FILE_PROBE.source}/${SPIKE_FILE_PROBE.flags}`,
    EXPECTED_FILE_PROBE_SOURCE,
    'FILE_PROBE in the snapshot no longer matches the one the 0.995 was measured against',
  );
});

test('the freeze is dated to the day the probe actually ran', () => {
  assert.equal(SPIKE_CLASSIFIER_FROZEN_ON, '2026-09-30');
  // The date is not a claim, it is read back out of the recorded artefact. If
  // the cassette is ever re-recorded on another day, this fails and the freeze
  // date has to be revisited deliberately rather than inherited.
  const scored = JSON.parse(fs.readFileSync(SPIKE_SCORED_PATH, 'utf8'));
  const recordedDay = String(scored.recordedAt).slice(0, 10);
  assert.equal(recordedDay, SPIKE_CLASSIFIER_FROZEN_ON, `two-class.json was recorded on ${recordedDay}, not ${SPIKE_CLASSIFIER_FROZEN_ON}`);
});

test('the frozen classifier reproduces the label of all 200 committed corpus rows', () => {
  const corpus = JSON.parse(fs.readFileSync(SPIKE_CORPUS_PATH, 'utf8'));
  assert.equal(corpus.length, 200, 'the committed corpus is 200 rows; a different count means the file was regenerated');

  const drifted = [];
  for (const row of corpus) {
    const now = classifySpikeSkipIf(row.cmd);
    if (now !== row.label) drifted.push({ cmd: row.cmd, committed: row.label, frozen: now });
  }
  assert.deepEqual(
    drifted,
    [],
    `${drifted.length} of ${corpus.length} committed corpus labels drifted: ${JSON.stringify(drifted.slice(0, 5))}`,
  );
});

test('the replayed probe still reproduces the committed agreement 0.995', async () => {
  // Replay mode reads the cassette. No network, no API key.
  const { runProbe } = await import('./spike-skipif-probe.mjs');
  const corpus = JSON.parse(fs.readFileSync(SPIKE_CORPUS_PATH, 'utf8'));
  const saved = JSON.parse(fs.readFileSync(SPIKE_SCORED_PATH, 'utf8'));
  const replayed = await runProbe({ corpus, mode: 'replay', out: null });

  assert.equal(replayed.summarize.agreement, 0.995, 'the published agreement is 0.995; a different number means the freeze leaked');
  assert.equal(replayed.summarize.agreement, saved.agreement, 'replay must equal the committed artefact, not merely round to it');
  assert.equal(replayed.summarize.ece, saved.ece);
  assert.equal(replayed.summarize.brier, saved.brier);
});

test('the spike scripts do not import the live classifier any more', async () => {
  // The stated risk in the plan: a re-import is how the freeze silently
  // evaporates on the next refactor. Assert it on the source text, not on
  // behaviour, because behaviour would be indistinguishable while the two
  // classifiers happen to agree.
  const ROOT = SPIKE_CORPUS_PATH.replace(/\/spike-out\/corpus\.json$/, '');
  for (const file of ['spike-skipif-corpus.mjs', 'spike-skipif-probe.mjs']) {
    const src = fs.readFileSync(`${ROOT}/scripts/${file}`, 'utf8');
    for (const line of src.split('\n')) {
      if (!/^\s*import\b/.test(line)) continue;
      if (line.includes('classifySkipIf') && !line.includes('classifySpikeSkipIf')) {
        assert.fail(`${file} still imports the live classifySkipIf from ultra-plan-runner.mjs:\n  ${line.trim()}`);
      }
    }
  }
});
