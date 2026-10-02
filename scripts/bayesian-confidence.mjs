#!/usr/bin/env node
// Bayesian confidence aggregation for multi-subagent code review.
//
// When N independent subagents each report a finding with confidence p_i,
// the combined posterior is computed via the odds form of Bayes' theorem:
//
//   posterior_odds = prior_odds × ∏(p_i / (1 - p_i))
//
// This is the naive Bayes combination rule, valid only when findings are
// conditionally independent given the hypothesis. The `independent` flag
// on each finding enforces this: dependent findings are skipped, because
// multiplying correlated evidence double-counts it and produces
// overconfident posteriors that no reviewer can catch.
//
// The threshold function maps a posterior to a discrete action:
//   >= 0.95  → auto-merge
//   >= 0.70  → human review
//   <  0.70  → reject
//
// Every formula has a hand-computed fixture in the test file.

export const DEFAULT_PRIOR = 0.5;
export const AUTO_MERGE_THRESHOLD = 0.95;
export const HUMAN_REVIEW_THRESHOLD = 0.70;

/**
 * Combine independent findings into a single posterior probability.
 * @param {Array<{confidence: number, independent: boolean}>} findings
 * @param {number} [prior] - prior probability (default 0.5)
 * @returns {number} posterior probability in [0, 1]
 */
export function combineConfidence(findings, prior = DEFAULT_PRIOR) {
  if (!Array.isArray(findings) || findings.length === 0) {
    throw new Error('combineConfidence: findings array must be non-empty');
  }
  if (typeof prior !== 'number' || prior <= 0 || prior >= 1) {
    throw new Error(`combineConfidence: prior=${prior} must be in (0, 1)`);
  }

  let priorOdds = prior / (1 - prior);
  for (const f of findings) {
    if (typeof f.confidence !== 'number' || Number.isNaN(f.confidence)) {
      throw new Error('combineConfidence: every finding needs a numeric confidence');
    }
    if (f.confidence <= 0 || f.confidence >= 1) {
      throw new Error(`combineConfidence: confidence=${f.confidence} must be in (0, 1)`);
    }
    if (f.independent !== true) continue;
    const likelihoodRatio = f.confidence / (1 - f.confidence);
    priorOdds *= likelihoodRatio;
  }
  return priorOdds / (1 + priorOdds);
}

/**
 * Classify a posterior probability into a discrete action.
 * @param {number} posterior
 * @returns {'auto-merge'|'human-review'|'reject'}
 */
export function classifyVerdict(posterior) {
  if (typeof posterior !== 'number' || Number.isNaN(posterior)) {
    throw new Error('classifyVerdict: posterior must be a number');
  }
  if (posterior < 0 || posterior > 1) {
    throw new Error(`classifyVerdict: posterior=${posterior} is out of range 0..1`);
  }
  if (posterior >= AUTO_MERGE_THRESHOLD) return 'auto-merge';
  if (posterior >= HUMAN_REVIEW_THRESHOLD) return 'human-review';
  return 'reject';
}

/**
 * Compute the weight of evidence (WOE) for a finding.
 * WOE = log(p / (1 - p)), measured in nats.
 * Positive WOE supports the hypothesis, negative WOE opposes it.
 * @param {number} confidence
 * @returns {number}
 */
export function weightOfEvidence(confidence) {
  if (typeof confidence !== 'number' || confidence <= 0 || confidence >= 1) {
    throw new Error(`weightOfEvidence: confidence=${confidence} must be in (0, 1)`);
  }
  return Math.log(confidence / (1 - confidence));
}

/**
 * Aggregate multiple findings and return a full verdict object.
 * @param {Array<{confidence: number, independent: boolean, source?: string}>} findings
 * @param {number} [prior]
 * @returns {{posterior: number, verdict: string, contributingCount: number, totalCount: number}}
 */
export function aggregateFindings(findings, prior = DEFAULT_PRIOR) {
  const posterior = combineConfidence(findings, prior);
  const verdict = classifyVerdict(posterior);
  const contributing = findings.filter((f) => f.independent !== false);
  return {
    posterior,
    verdict,
    contributingCount: contributing.length,
    totalCount: findings.length,
  };
}
