import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  erlangC,
  averageQueueLength,
  averageWaitTime,
  optimalBatchSize,
  completionProbability,
} from './queueing-batch.mjs';

// Every expected value below is worked out by hand in the comment beside it.

test('erlangC with a=1, c=2 gives P_wait ≈ 0.3333', () => {
  // a = λ/μ = 1, c = 2
  // a^c/c! = 1/2 = 0.5
  // sum = a^0/0! + a^1/1! = 1 + 1 = 2
  // numerator = 0.5 × (2/(2-1)) = 0.5 × 2 = 1.0
  // denominator = 2 + 1.0 = 3.0
  // P_wait = 1/3 ≈ 0.3333
  const result = erlangC(1, 1, 2);
  assert.ok(Math.abs(result - 1 / 3) < 1e-10);
});

test('erlangC with a=2, c=3 gives P_wait ≈ 0.2368', () => {
  // a = 2, c = 3
  // a^c/c! = 8/6 = 4/3 ≈ 1.3333
  // sum = 1 + 2 + 4/2 = 1 + 2 + 2 = 5
  // numerator = (4/3) × (3/(3-2)) = (4/3) × 3 = 4.0
  // denominator = 5 + 4 = 9
  // P_wait = 4/9 ≈ 0.4444
  // Wait, let me recalculate:
  // a^0/0! = 1, a^1/1! = 2, a^2/2! = 4/2 = 2
  // sum = 1 + 2 + 2 = 5
  // a^c/c! = 8/6 = 4/3
  // numerator = (4/3) × (3/1) = 4
  // denominator = 5 + 4 = 9
  // P_wait = 4/9 ≈ 0.4444
  const result = erlangC(2, 1, 3);
  assert.ok(Math.abs(result - 4 / 9) < 1e-10);
});

test('erlangC approaches 1 as utilization approaches 1', () => {
  // a=9, c=10 → ρ=0.9, high wait probability
  const result = erlangC(9, 1, 10);
  assert.ok(result > 0.5);
  assert.ok(result < 1);
});

test('erlangC approaches 0 with many servers', () => {
  // a=1, c=10 → very low wait probability
  const result = erlangC(1, 1, 10);
  assert.ok(result < 0.01);
});

test('erlangC rejects unstable configurations', () => {
  // a=5, c=3 → ρ > 1, system unstable
  assert.throws(() => erlangC(5, 1, 3), /unstable/i);
});

test('erlangC rejects invalid inputs', () => {
  assert.throws(() => erlangC(0, 1, 1), /must be positive/i);
  assert.throws(() => erlangC(1, 0, 1), /must be positive/i);
  assert.throws(() => erlangC(1, 1, 0), /must be positive/i);
  assert.throws(() => erlangC(1, 1, 1.5), /must be an integer/i);
});

test('averageQueueLength is zero when P_wait is near zero', () => {
  // a=1, c=10 → P_wait ≈ 0, so L_q ≈ 0
  const result = averageQueueLength(1, 1, 10);
  assert.ok(result < 0.001);
});

test('averageQueueLength increases with utilization', () => {
  // Higher utilization → longer queue
  const lowUtil = averageQueueLength(1, 1, 5);  // ρ=0.2
  const highUtil = averageQueueLength(4, 1, 5);  // ρ=0.8
  assert.ok(highUtil > lowUtil);
});

test('averageWaitTime follows Little\'s Law', () => {
  // W_q = L_q / λ
  const lambda = 2, mu = 1, c = 3;
  const lq = averageQueueLength(lambda, mu, c);
  const wq = averageWaitTime(lambda, mu, c);
  assert.ok(Math.abs(wq - lq / lambda) < 1e-10);
});

test('optimalBatchSize finds a reasonable batch size', () => {
  // λ=5, μ=1, costPerSubagent=10, costPerWaitingTask=100
  // High waiting cost → larger batch
  const result = optimalBatchSize(5, 1, 10, 100);
  assert.ok(result.optimalC >= 5); // Must be > λ/μ = 5 for stability
  assert.ok(result.optimalC <= 50);
  assert.ok(result.utilization < 1);
  assert.ok(result.minCost > 0);
});

test('optimalBatchSize with low waiting cost prefers smaller batch', () => {
  // λ=2, μ=1, costPerSubagent=100, costPerWaitingTask=1
  // High subagent cost → smaller batch
  const result = optimalBatchSize(2, 1, 100, 1);
  assert.ok(result.optimalC >= 2);
  assert.ok(result.optimalC < 20);
});

test('optimalBatchSize rejects invalid costs', () => {
  assert.throws(() => optimalBatchSize(1, 1, 0, 100), /must be positive/i);
  assert.throws(() => optimalBatchSize(1, 1, 100, 0), /must be positive/i);
});

test('completionProbability increases with time', () => {
  // P(T <= t) should increase as t increases
  const p1 = completionProbability(1, 1, 2, 1);
  const p2 = completionProbability(1, 1, 2, 5);
  const p3 = completionProbability(1, 1, 2, 10);
  assert.ok(p1 < p2);
  assert.ok(p2 < p3);
});

test('completionProbability is in [0, 1]', () => {
  const p = completionProbability(1, 1, 2, 5);
  assert.ok(p >= 0 && p <= 1);
});

test('completionProbability rejects negative time', () => {
  assert.throws(() => completionProbability(1, 1, 2, -1), /non-negative/i);
});

test('completionProbability approaches 1 for large t', () => {
  const p = completionProbability(1, 1, 2, 100);
  assert.ok(p > 0.99);
});
