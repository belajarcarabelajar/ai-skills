import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  combineConfidence,
  classifyVerdict,
  weightOfEvidence,
  aggregateFindings,
  DEFAULT_PRIOR,
  AUTO_MERGE_THRESHOLD,
  HUMAN_REVIEW_THRESHOLD,
} from './bayesian-confidence.mjs';

// Every expected value below is worked out by hand in the comment beside it.

test('combineConfidence with a single finding at p=0.8 and prior=0.5', () => {
  // prior_odds = 0.5/0.5 = 1.0
  // likelihood_ratio = 0.8/0.2 = 4.0
  // posterior_odds = 1.0 × 4.0 = 4.0
  // posterior = 4.0 / (1.0 + 4.0) = 0.8
  const result = combineConfidence([{ confidence: 0.8, independent: true }], 0.5);
  assert.equal(result, 0.8);
});

test('combineConfidence with two independent findings at p=0.8 each', () => {
  // prior_odds = 1.0
  // LR1 = 0.8/0.2 = 4.0, LR2 = 4.0
  // posterior_odds = 1.0 × 4.0 × 4.0 = 16.0
  // posterior = 16.0 / 17.0 ≈ 0.9412
  const result = combineConfidence([
    { confidence: 0.8, independent: true },
    { confidence: 0.8, independent: true },
  ], 0.5);
  assert.ok(Math.abs(result - 16 / 17) < 1e-10);
});

test('combineConfidence skips dependent findings', () => {
  // Only the independent finding counts: p=0.8, prior=0.5 → 0.8
  const result = combineConfidence([
    { confidence: 0.99, independent: false },
    { confidence: 0.8, independent: true },
  ], 0.5);
  assert.equal(result, 0.8);
});

test('combineConfidence with three independent findings at p=0.7', () => {
  // prior_odds = 1.0
  // LR = 0.7/0.3 = 7/3 ≈ 2.3333
  // posterior_odds = (7/3)^3 = 343/27 ≈ 12.7037
  // posterior = (343/27) / (1 + 343/27) = 343/370 ≈ 0.9270
  const result = combineConfidence([
    { confidence: 0.7, independent: true },
    { confidence: 0.7, independent: true },
    { confidence: 0.7, independent: true },
  ], 0.5);
  assert.ok(Math.abs(result - 343 / 370) < 1e-10);
});

test('combineConfidence with a strong prior shifts the result', () => {
  // prior=0.9 → prior_odds = 0.9/0.1 = 9.0
  // LR = 0.5/0.5 = 1.0 (uninformative finding)
  // posterior_odds = 9.0 × 1.0 = 9.0
  // posterior = 9.0/10.0 = 0.9
  const result = combineConfidence([{ confidence: 0.5, independent: true }], 0.9);
  assert.equal(result, 0.9);
});

test('combineConfidence rejects empty findings', () => {
  assert.throws(() => combineConfidence([]), /non-empty/i);
});

test('combineConfidence rejects invalid confidence values', () => {
  assert.throws(() => combineConfidence([{ confidence: 0, independent: true }]), /must be in/i);
  assert.throws(() => combineConfidence([{ confidence: 1, independent: true }]), /must be in/i);
  assert.throws(() => combineConfidence([{ confidence: 1.5, independent: true }]), /must be in/i);
});

test('combineConfidence rejects invalid prior', () => {
  assert.throws(() => combineConfidence([{ confidence: 0.5, independent: true }], 0), /must be in/i);
  assert.throws(() => combineConfidence([{ confidence: 0.5, independent: true }], 1), /must be in/i);
});

test('classifyVerdict returns auto-merge for posterior >= 0.95', () => {
  assert.equal(classifyVerdict(0.95), 'auto-merge');
  assert.equal(classifyVerdict(0.99), 'auto-merge');
  assert.equal(classifyVerdict(1.0), 'auto-merge');
});

test('classifyVerdict returns human-review for 0.70 <= posterior < 0.95', () => {
  assert.equal(classifyVerdict(0.7), 'human-review');
  assert.equal(classifyVerdict(0.85), 'human-review');
  assert.equal(classifyVerdict(0.94), 'human-review');
});

test('classifyVerdict returns reject for posterior < 0.70', () => {
  assert.equal(classifyVerdict(0.69), 'reject');
  assert.equal(classifyVerdict(0.5), 'reject');
  assert.equal(classifyVerdict(0.0), 'reject');
});

test('classifyVerdict rejects out-of-range values', () => {
  assert.throws(() => classifyVerdict(-0.1), /out of range/i);
  assert.throws(() => classifyVerdict(1.1), /out of range/i);
  assert.throws(() => classifyVerdict(NaN), /must be a number/i);
});

test('weightOfEvidence is zero at p=0.5', () => {
  // log(0.5/0.5) = log(1) = 0
  assert.equal(weightOfEvidence(0.5), 0);
});

test('weightOfEvidence is positive for p > 0.5', () => {
  // log(0.8/0.2) = log(4) ≈ 1.3863
  const woe = weightOfEvidence(0.8);
  assert.ok(woe > 0);
  assert.ok(Math.abs(woe - Math.log(4)) < 1e-10);
});

test('weightOfEvidence is negative for p < 0.5', () => {
  // log(0.2/0.8) = log(0.25) ≈ -1.3863
  const woe = weightOfEvidence(0.2);
  assert.ok(woe < 0);
  assert.ok(Math.abs(woe - Math.log(0.25)) < 1e-10);
});

test('weightOfEvidence rejects boundary values', () => {
  assert.throws(() => weightOfEvidence(0), /must be in/i);
  assert.throws(() => weightOfEvidence(1), /must be in/i);
});

test('aggregateFindings returns a complete verdict object', () => {
  const result = aggregateFindings([
    { confidence: 0.9, independent: true, source: 'subagent-1' },
    { confidence: 0.85, independent: true, source: 'subagent-2' },
    { confidence: 0.99, independent: false, source: 'subagent-3' },
  ], 0.5);

  // prior_odds = 1.0
  // LR1 = 0.9/0.1 = 9.0, LR2 = 0.85/0.15 = 17/3 ≈ 5.6667
  // posterior_odds = 1.0 × 9.0 × (17/3) = 51.0
  // posterior = 51.0 / 52.0 ≈ 0.9808
  assert.ok(Math.abs(result.posterior - 51 / 52) < 1e-10);
  assert.equal(result.verdict, 'auto-merge');
  assert.equal(result.contributingCount, 2);
  assert.equal(result.totalCount, 3);
});

test('aggregateFindings with low-confidence findings returns reject', () => {
  const result = aggregateFindings([
    { confidence: 0.55, independent: true },
    { confidence: 0.6, independent: true },
  ], 0.5);

  // prior_odds = 1.0
  // LR1 = 0.55/0.45 = 11/9 ≈ 1.2222, LR2 = 0.6/0.4 = 1.5
  // posterior_odds = 1.0 × (11/9) × 1.5 = 11/6 ≈ 1.8333
  // posterior = (11/6) / (1 + 11/6) = 11/17 ≈ 0.6471
  assert.ok(Math.abs(result.posterior - 11 / 17) < 1e-10);
  assert.equal(result.verdict, 'reject');
});

test('DEFAULT_PRIOR is 0.5', () => {
  assert.equal(DEFAULT_PRIOR, 0.5);
});

test('thresholds are correctly defined', () => {
  assert.equal(AUTO_MERGE_THRESHOLD, 0.95);
  assert.equal(HUMAN_REVIEW_THRESHOLD, 0.7);
});
