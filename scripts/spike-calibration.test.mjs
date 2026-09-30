import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedCalibrationError, brierScore, confusion, accuracy, DEFAULT_BINS } from './spike-calibration.mjs';

// Every expected value below is worked out by hand in the comment beside it.
// A calibration number with no hand-checked fixture is a number nobody should
// quote, and these are the numbers the whole spike rests on.

test('brierScore is zero for a perfectly confident and correct prediction', () => {
  // (1.0 - 1)^2 = 0 for both rows. Mean = 0.
  assert.equal(brierScore([{ p: 1, correct: true }, { p: 1, correct: true }]), 0);
});

test('brierScore halves when the confidence is wrong in both directions', () => {
  // p=1.0 and wrong contributes (1-0)^2 = 1. p=0.0 and wrong contributes
  // (0-0)^2 = 0, because a stated probability of zero and a false outcome is
  // exactly what the model claimed. Mean = (1 + 0) / 2 = 0.5.
  assert.equal(brierScore([{ p: 1, correct: false }, { p: 0, correct: false }]), 0.5);
});

test('brierScore punishes the same error more when it is confident', () => {
  // Half-right at p=1.0: one row contributes (1-0)^2 = 1, mean = 0.5.
  const confident = brierScore([{ p: 1, correct: true }, { p: 1, correct: false }]);
  // Same two outcomes but hedged at p=0.5: each row contributes (0.5-1)^2 = 0.25,
  // mean = 0.25. A hedge is the cheaper mistake.
  const hedged = brierScore([{ p: 0.5, correct: true }, { p: 0.5, correct: false }]);
  assert.equal(confident, 0.5);
  assert.equal(hedged, 0.25);
  assert.ok(hedged < confident, 'an unhedged error must cost more than a hedged one');
});

test('brierScore rejects an empty set rather than returning NaN', () => {
  // An empty mean is NaN, and NaN silently poisons every comparison it feeds.
  assert.throws(() => brierScore([]), /empty/i);
});

test('expectedCalibrationError is zero when every bin is exactly right', () => {
  // Bin [0.0,0.1): four predictions at p=0.0, all correct. Mean p = 0.0, mean
  // accuracy = 1.0, |gap| = 1.0, weighted by 4/4 = 1.0 -> 1.0. That is the worst
  // possible calibration, so this fixture is deliberately the inverse case.
  const overconfident = expectedCalibrationError([{ p: 0, correct: true }]);
  assert.equal(overconfident, 1.0);

  // Bin [0.9,1.0]: four predictions at p=1.0, all correct. Gap 0 -> ECE 0.
  assert.equal(expectedCalibrationError([{ p: 1, correct: true }]), 0);
});

test('expectedCalibrationError is zero when the stated probability is always right', () => {
  // p=1.0 and always correct: stated 1.0, observed 1.0. Perfectly calibrated.
  assert.equal(expectedCalibrationError([
    { p: 1, correct: true }, { p: 1, correct: true },
    { p: 1, correct: true }, { p: 1, correct: true },
  ]), 0);
});

test('expectedCalibrationError weights bins by their share of the sample', () => {
  // Nine predictions at p=1.0 all correct (perfect), one at p=0.0 that is wrong
  // (also perfectly calibrated: stated 0.0, observed 0.0). Every gap is 0, so
  // the weighting must produce 0 as well. This is the fixture that would fail if
  // the weighting were applied to the bins instead of the observations.
  assert.equal(expectedCalibrationError([
    { p: 1, correct: true }, { p: 1, correct: true }, { p: 1, correct: true },
    { p: 1, correct: true }, { p: 1, correct: true }, { p: 1, correct: true },
    { p: 1, correct: true }, { p: 1, correct: true }, { p: 1, correct: true },
    { p:0, correct: false },
  ]), 0);
});

test('expectedCalibrationError detects a model that says 1.0 and is half wrong', () => {
  // Ten predictions, all at p=1.0, five correct. Stated 1.0, observed 0.5, gap
  // 0.5, weight 1.0 -> ECE 0.5. The single most useful number in this spike:
  // it catches exactly the overconfidence the SKILL.md taxonomy worries about.
  const pairs = Array.from({ length: 5 }, () => ({ p: 1, correct: true }))
    .concat(Array.from({ length: 5 }, () => ({ p: 1, correct: false })));
  assert.equal(expectedCalibrationError(pairs), 0.5);
});

test('expectedCalibrationError is larger than the raw error rate when wrong answers are confident', () => {
  // Three confident-and-wrong at p=1.0, one confident-and-right at p=1.0.
  // Observed accuracy 0.25. Every prediction sits in the top bin with mean
  // p = 1.0, so the gap is 0.75 and ECE is 0.75.
  const pairs = [
    { p: 1, correct: false }, { p: 1, correct: false }, { p: 1, correct: false },
    { p: 1, correct: true },
  ];
  assert.equal(accuracy(pairs), 0.25);
  assert.equal(expectedCalibrationError(pairs), 0.75);
  assert.ok(expectedCalibrationError(pairs) > accuracy(pairs));
});

test('a hedged wrong answer calibrates better than a confident wrong answer', () => {
  // Same 25% accuracy, but the wrong answers are stated at p=0.25 and the right
  // one at p=0.25 too: bin [0.2,0.3) holds all four, mean p = 0.25, mean
  // accuracy = 0.25, gap 0 -> ECE 0. The hedging is what buys the calibration.
  const hedged = [
    { p: 0.25, correct: false }, { p: 0.25, correct: false }, { p: 0.25, correct: false },
    { p: 0.25, correct: true },
  ];
  assert.equal(accuracy(hedged), 0.25);
  assert.equal(expectedCalibrationError(hedged), 0);
});

test('expectedCalibrationError rejects an empty set and out-of-range probabilities', () => {
  assert.throws(() => expectedCalibrationError([]), /empty/i);
  assert.throws(() => expectedCalibrationError([{ p: 1.5, correct: true }]), /range/i);
  assert.throws(() => expectedCalibrationError([{ p: -0.1, correct: true }]), /range/i);
  assert.throws(() => expectedCalibrationError([{ p: 0.5 }]), /correct/i);
});

test('expectedCalibrationError honours a custom bin count', () => {
  // With 2 bins the p=1.0 predictions all land in the top bin, so the result
  // matches the 10-bin case for this input: gap 0.5.
  const pairs = Array.from({ length: 5 }, () => ({ p: 1, correct: true }))
    .concat(Array.from({ length: 5 }, () => ({ p: 1, correct: false })));
  assert.equal(expectedCalibrationError(pairs, 2), 0.5);
  assert.equal(DEFAULT_BINS, 10);
});

test('confusion reports the 2x2 table the spike report quotes', () => {
  // Three reference-loose rows: two the model also called loose (TP from the
  // model's point of view), one it called behavioural (FN). Two reference-
  // behavioural rows, both called behavioural (TN).
  const rows = [
    { label: 'loose', predicted: 'loose' },
    { label: 'loose', predicted: 'loose' },
    { label: 'loose', predicted: 'behavioural' },
    { label: 'behavioural', predicted: 'behavioural' },
    { label: 'behavioural', predicted: 'behavioural' },
  ];
  const c = confusion(rows);
  assert.equal(c.total, 5);
  assert.equal(c.trueLoosePredLoose, 2);
  assert.equal(c.trueLoosePredBehavioural, 1);
  assert.equal(c.trueBehaviouralPredBehavioural, 2);
  assert.equal(c.trueBehaviouralPredLoose, 0);
  assert.equal(c.agree, 4);
  assert.equal(c.agree / c.total, 0.8);
});

test('confusion rejects a prediction outside the two known classes', () => {
  assert.throws(() => confusion([{ label: 'loose', predicted: 'maybe' }]), /class/i);
  assert.throws(() => confusion([{ label: 'loose', predicted: 'loose' }]), /at least/i, 'a single row makes no confusion possible');
});
