#!/usr/bin/env node
// Spike T2 — calibration metrics.
//
// Expected calibration error answers one question: when this model says 0.8,
// is it right 80% of the time? Brier score is the mean squared error of the
// stated probability against the 0/1 outcome, so it rewards hedging.
//
// Both are computed here rather than pulled from a package because the whole
// spike quotes their output, and a reviewer should be able to read the
// definition instead of trusting a dependency. Every formula has a
// hand-computed fixture in the test file.

export const DEFAULT_BINS = 10;
const CLASSES = new Set(['behavioural', 'loose']);

function validatePairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error('expectedCalibrationError/brierScore: the input set is empty');
  }
  for (const row of pairs) {
    if (typeof row.p !== 'number' || Number.isNaN(row.p)) {
      throw new Error('expectedCalibrationError/brierScore: every row needs a numeric `p`');
    }
    if (row.p < 0 || row.p > 1) {
      throw new Error(`expectedCalibrationError/brierScore: p=${row.p} is out of range 0..1`);
    }
    if (typeof row.correct !== 'boolean') {
      throw new Error('expectedCalibrationError/brierScore: every row needs a boolean `correct`');
    }
  }
}

// Equal-width bins over 0..1. The top bin is closed on the right so p === 1
// lands in the last bin instead of falling outside every bin and silently
// contributing weight 0, which would make an overconfident model look
// calibrated.
function binIndex(p, bins) {
  const idx = Math.floor(p * bins);
  return idx >= bins ? bins - 1 : idx;
}

export function expectedCalibrationError(pairs, bins = DEFAULT_BINS) {
  validatePairs(pairs);
  if (!Number.isInteger(bins) || bins < 1) {
    throw new Error(`expectedCalibrationError: bins=${bins} must be a positive integer`);
  }
  const groups = Array.from({ length: bins }, () => []);
  for (const row of pairs) groups[binIndex(row.p, bins)].push(row);

  const total = pairs.length;
  let ece = 0;
  for (const group of groups) {
    if (group.length === 0) continue;
    const meanP = group.reduce((sum, r) => sum + r.p, 0) / group.length;
    const observed = group.filter((r) => r.correct).length / group.length;
    ece += (group.length / total) * Math.abs(meanP - observed);
  }
  return ece;
}

export function brierScore(pairs) {
  validatePairs(pairs);
  return pairs.reduce((sum, r) => sum + (r.p - (r.correct ? 1 : 0)) ** 2, 0) / pairs.length;
}

export function accuracy(pairs) {
  validatePairs(pairs);
  return pairs.filter((r) => r.correct).length / pairs.length;
}

// The 2x2 table, oriented from the reference label's point of view so the
// report can quote a number a reader can check against the raw rows.
export function confusion(rows) {
  if (!Array.isArray(rows)) {
    throw new Error('confusion: expected an array of { label, predicted } rows');
  }
  // Class validation runs before the size check. An unknown class is the more
  // specific defect, and reporting "needs at least two rows" for a single row
  // with a typo in `predicted` sends the reader looking in the wrong place.
  for (const row of rows) {
    if (!CLASSES.has(row?.label)) throw new Error(`confusion: unknown reference class "${row?.label}"`);
    if (!CLASSES.has(row?.predicted)) throw new Error(`confusion: unknown predicted class "${row?.predicted}"`);
  }
  if (rows.length < 2) {
    throw new Error('confusion: a 2x2 table needs at least two rows');
  }
  const out = {
    total: rows.length,
    trueLoosePredLoose: 0,
    trueLoosePredBehavioural: 0,
    trueBehaviouralPredBehavioural: 0,
    trueBehaviouralPredLoose: 0,
    agree: 0,
  };
  for (const row of rows) {
    if (row.label === row.predicted) {
      out.agree++;
      out[row.label === 'loose' ? 'trueLoosePredLoose' : 'trueBehaviouralPredBehavioural']++;
    } else {
      out[row.label === 'loose' ? 'trueLoosePredBehavioural' : 'trueBehaviouralPredLoose']++;
    }
  }
  return out;
}
