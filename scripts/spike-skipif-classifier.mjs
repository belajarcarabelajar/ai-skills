#!/usr/bin/env node
// T1 — the classifier snapshot the Jev decision-gate spike was measured against.
//
// DO NOT IMPROVE THESE TWO REGEXES. They are not the current best rules; they
// are the rules that produced the committed evidence in
// `spike-out/two-class.json` (agreement 0.995, ECE 0.011, Brier 0.005,
// $0.004129, jev-1.13.0) as published in
// `docs/code-plan/spikes/2026-09-30-jev-decision-gate-spike-report.md`.
//
// The production `classifySkipIf` in `scripts/ultra-plan-runner.mjs` is going to
// change: it gains `sentinel` and `unknown` return values, and `FILE_PROBE`
// widens to catch path-qualified and `tgrep`-prefixed probes. Those changes are
// correct. They also make 32+ rows of `spike-out/corpus.json` stale, at which
// point `summarize()` throws `stale label` and the published 0.995 stops being
// reproducible.
//
// The alternative to freezing is re-recording the corpus and re-running the
// probe, which would produce a new number measured against a different
// classifier and quietly rewrite a published verdict. Freezing preserves the
// claim. So the spike scripts import this snapshot and never the live function.
//
// What is preserved is the measurement, not the answer. `bash` and `md5sum` are
// still absent from `EVIDENCE_COMMAND` here, and that is exactly the point:
// this file is a record of what was measured, while
// `skipif-registry-audit.mjs` is the command that reports what is actually wrong
// with the live rule.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The day the probe ran, as recorded in `two-class.json`'s `recordedAt`
// (2026-09-30T00:12:26.644Z). Asserted against that file in the test, so it
// stays a fact rather than a claim.
export const SPIKE_CLASSIFIER_FROZEN_ON = '2026-09-30';

// Verbatim from `scripts/ultra-plan-runner.mjs` on the freeze date. Renamed, not
// edited — the test file holds an independent copy of both source strings and
// compares them byte-for-byte, so a future edit to either side is visible
// instead of being absorbed silently.
export const SPIKE_EVIDENCE_COMMAND =
  /\b(bun|node|npm|pnpm|yarn|deno|python3?|pytest|go|cargo|make|cmake|git|systemctl|curl|docker|tsc|eslint|vitest|jest|ruff|mypy|gradle|mvn)\b/;
export const SPIKE_FILE_PROBE =
  /(^|[\s;&|(])(grep|egrep|rg|cat|head|tail|ls|find|wc|test)\b/;

// The three-branch body of the production `classifySkipIf` as it stood then.
// `empty` is retained even though a harvested corpus is necessarily two-class:
// blank rows are dropped during normalisation, so the branch is unreachable in
// the corpus but is part of the frozen function's contract.
export function classifySpikeSkipIf(cmd) {
  if (typeof cmd !== 'string' || cmd.trim() === '') return 'empty';
  if (SPIKE_EVIDENCE_COMMAND.test(cmd)) return 'behavioural';
  return SPIKE_FILE_PROBE.test(cmd) ? 'loose' : 'behavioural';
}

export const SPIKE_CORPUS_PATH = path.join(ROOT, 'spike-out', 'corpus.json');
export const SPIKE_SCORED_PATH = path.join(ROOT, 'spike-out', 'two-class.json');
