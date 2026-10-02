import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAcyclic,
  hasReferentialIntegrity,
  hasMutuallyExclusiveScopes,
  hasValidGateOrdering,
  hasUniqueIdempotencyKeys,
  validateInvariants,
  canDispatchInParallel,
  computeWaves,
  validateParallelDispatch,
  maxParallelism,
  checkFanOutFloor,
} from './formal-invariants.mjs';

// Every expected value below is worked out by hand in the comment beside it.

test('isAcyclic returns true for a valid DAG', () => {
  // A → B → C, A → C (no cycles)
  const graph = new Map([
    ['A', []],
    ['B', ['A']],
    ['C', ['A', 'B']],
  ]);
  assert.equal(isAcyclic(graph), true);
});

test('isAcyclic detects a simple cycle', () => {
  // A → B → A
  const graph = new Map([
    ['A', ['B']],
    ['B', ['A']],
  ]);
  const result = isAcyclic(graph);
  assert.notEqual(result, true);
  assert.ok(result.includes('cycle'));
  assert.ok(result.includes('A'));
  assert.ok(result.includes('B'));
});

test('isAcyclic detects a longer cycle', () => {
  // A → B → C → A
  const graph = new Map([
    ['A', ['C']],
    ['B', ['A']],
    ['C', ['B']],
  ]);
  const result = isAcyclic(graph);
  assert.notEqual(result, true);
  assert.ok(result.includes('cycle'));
});

test('isAcyclic returns true for an empty graph', () => {
  assert.equal(isAcyclic(new Map()), true);
});

test('isAcyclic handles a diamond shape', () => {
  // A → B, A → C, B → D, C → D (no cycles)
  const graph = new Map([
    ['A', []],
    ['B', ['A']],
    ['C', ['A']],
    ['D', ['B', 'C']],
  ]);
  assert.equal(isAcyclic(graph), true);
});

test('hasReferentialIntegrity returns true when all deps exist', () => {
  const graph = new Map([
    ['A', []],
    ['B', ['A']],
  ]);
  const taskIds = new Set(['A', 'B']);
  assert.equal(hasReferentialIntegrity(graph, taskIds), true);
});

test('hasReferentialIntegrity detects a dangling dependency', () => {
  const graph = new Map([
    ['A', []],
    ['B', ['A', 'C']], // C does not exist
  ]);
  const taskIds = new Set(['A', 'B']);
  const result = hasReferentialIntegrity(graph, taskIds);
  assert.notEqual(result, true);
  assert.ok(result.includes('C'));
});

test('hasReferentialIntegrity detects a task not in the task set', () => {
  const graph = new Map([
    ['A', []],
    ['B', ['A']],
    ['X', ['A']], // X is in graph but not in taskIds
  ]);
  const taskIds = new Set(['A', 'B']);
  const result = hasReferentialIntegrity(graph, taskIds);
  assert.notEqual(result, true);
  assert.ok(result.includes('X'));
});

test('hasMutuallyExclusiveScopes returns true when no overlap', () => {
  const scopes = new Map([
    ['A', new Set(['file1.ts', 'file2.ts'])],
    ['B', new Set(['file3.ts'])],
    ['C', new Set(['file4.ts', 'file5.ts'])],
  ]);
  assert.equal(hasMutuallyExclusiveScopes(scopes), true);
});

test('hasMutuallyExclusiveScopes detects overlapping file claims', () => {
  const scopes = new Map([
    ['A', new Set(['file1.ts', 'shared.ts'])],
    ['B', new Set(['shared.ts', 'file3.ts'])],
  ]);
  const result = hasMutuallyExclusiveScopes(scopes);
  assert.notEqual(result, true);
  assert.ok(result.includes('shared.ts'));
  assert.ok(result.includes('A'));
  assert.ok(result.includes('B'));
});

test('hasMutuallyExclusiveScopes returns true for empty scopes', () => {
  assert.equal(hasMutuallyExclusiveScopes(new Map()), true);
});

test('hasValidGateOrdering returns true for valid phases', () => {
  const tasks = [
    { id: 'A', phase: 'planning' },
    { id: 'B', phase: 'implementation' },
    { id: 'C', phase: 'verification' },
  ];
  assert.equal(hasValidGateOrdering(tasks), true);
});

test('hasValidGateOrdering detects unknown phase', () => {
  const tasks = [
    { id: 'A', phase: 'planning' },
    { id: 'B', phase: 'unknown-phase' },
  ];
  const result = hasValidGateOrdering(tasks);
  assert.notEqual(result, true);
  assert.ok(result.includes('unknown-phase'));
});

test('hasUniqueIdempotencyKeys returns true when all keys are unique', () => {
  const tasks = [
    { id: 'A', idempotencyKey: 'key-1' },
    { id: 'B', idempotencyKey: 'key-2' },
    { id: 'C', idempotencyKey: 'key-3' },
  ];
  assert.equal(hasUniqueIdempotencyKeys(tasks), true);
});

test('hasUniqueIdempotencyKeys detects duplicate keys', () => {
  const tasks = [
    { id: 'A', idempotencyKey: 'key-1' },
    { id: 'B', idempotencyKey: 'key-1' }, // duplicate
  ];
  const result = hasUniqueIdempotencyKeys(tasks);
  assert.notEqual(result, true);
  assert.ok(result.includes('key-1'));
  assert.ok(result.includes('A'));
  assert.ok(result.includes('B'));
});

test('validateInvariants returns empty array for a valid plan', () => {
  const plan = {
    tasks: [
      { id: 'A', depends_on: [], files: ['file1.ts'], phase: 'planning', idempotencyKey: 'key-1' },
      { id: 'B', depends_on: ['A'], files: ['file2.ts'], phase: 'implementation', idempotencyKey: 'key-2' },
      { id: 'C', depends_on: ['B'], files: ['file3.ts'], phase: 'verification', idempotencyKey: 'key-3' },
    ],
  };
  const violations = validateInvariants(plan);
  assert.equal(violations.length, 0);
});

test('validateInvariants detects multiple violations', () => {
  const plan = {
    tasks: [
      { id: 'A', depends_on: ['B'], files: ['shared.ts'], phase: 'planning', idempotencyKey: 'key-1' },
      { id: 'B', depends_on: ['A'], files: ['shared.ts'], phase: 'implementation', idempotencyKey: 'key-1' },
    ],
  };
  const violations = validateInvariants(plan);
  assert.ok(violations.length >= 2); // cycle + duplicate key + overlapping scope
});

test('validateInvariants handles empty plan', () => {
  const violations = validateInvariants({ tasks: [] });
  assert.equal(violations.length, 0);
});

// ============================================================================
// Parallel dispatch tests
// ============================================================================

test('canDispatchInParallel returns true for independent tasks with disjoint files', () => {
  const taskA = { id: 'A', depends_on: [], files: ['file1.ts'] };
  const taskB = { id: 'B', depends_on: [], files: ['file2.ts'] };
  assert.equal(canDispatchInParallel(taskA, taskB), true);
});

test('canDispatchInParallel returns false when tasks share a file', () => {
  const taskA = { id: 'A', depends_on: [], files: ['shared.ts'] };
  const taskB = { id: 'B', depends_on: [], files: ['shared.ts'] };
  assert.equal(canDispatchInParallel(taskA, taskB), false);
});

test('canDispatchInParallel returns false when one depends on the other', () => {
  const taskA = { id: 'A', depends_on: [], files: ['file1.ts'] };
  const taskB = { id: 'B', depends_on: ['A'], files: ['file2.ts'] };
  assert.equal(canDispatchInParallel(taskA, taskB), false);
});

test('canDispatchInParallel returns false when dependency is reversed', () => {
  const taskA = { id: 'A', depends_on: ['B'], files: ['file1.ts'] };
  const taskB = { id: 'B', depends_on: [], files: ['file2.ts'] };
  assert.equal(canDispatchInParallel(taskA, taskB), false);
});

test('canDispatchInParallel returns true for tasks with no files (read-only)', () => {
  const taskA = { id: 'A', depends_on: [], files: [] };
  const taskB = { id: 'B', depends_on: [], files: [] };
  assert.equal(canDispatchInParallel(taskA, taskB), true);
});

test('canDispatchInParallel returns false when one task has empty files and other has files', () => {
  // Empty files means read-only, so no conflict
  const taskA = { id: 'A', depends_on: [], files: [] };
  const taskB = { id: 'B', depends_on: [], files: ['file1.ts'] };
  assert.equal(canDispatchInParallel(taskA, taskB), true);
});

test('computeWaves assigns wave 0 to tasks with no dependencies', () => {
  const graph = new Map([
    ['A', []],
    ['B', []],
    ['C', ['A', 'B']],
  ]);
  const waves = computeWaves(graph);
  assert.equal(waves.get('A'), 0);
  assert.equal(waves.get('B'), 0);
  assert.equal(waves.get('C'), 1);
});

test('computeWaves assigns correct waves for a linear chain', () => {
  const graph = new Map([
    ['A', []],
    ['B', ['A']],
    ['C', ['B']],
    ['D', ['C']],
  ]);
  const waves = computeWaves(graph);
  assert.equal(waves.get('A'), 0);
  assert.equal(waves.get('B'), 1);
  assert.equal(waves.get('C'), 2);
  assert.equal(waves.get('D'), 3);
});

test('computeWaves assigns correct waves for a diamond DAG', () => {
  // A → B, A → C, B → D, C → D
  const graph = new Map([
    ['A', []],
    ['B', ['A']],
    ['C', ['A']],
    ['D', ['B', 'C']],
  ]);
  const waves = computeWaves(graph);
  assert.equal(waves.get('A'), 0);
  assert.equal(waves.get('B'), 1);
  assert.equal(waves.get('C'), 1);
  assert.equal(waves.get('D'), 2);
});

test('computeWaves throws on cyclic graph', () => {
  const graph = new Map([
    ['A', ['B']],
    ['B', ['A']],
  ]);
  assert.throws(() => computeWaves(graph), /cycle/i);
});

test('computeWaves handles empty graph', () => {
  const waves = computeWaves(new Map());
  assert.equal(waves.size, 0);
});

test('validateParallelDispatch returns true for valid same-wave batch', () => {
  const waves = new Map([
    ['A', 0],
    ['B', 0],
    ['C', 1],
  ]);
  const batch = [
    { id: 'A', depends_on: [], files: ['file1.ts'] },
    { id: 'B', depends_on: [], files: ['file2.ts'] },
  ];
  assert.equal(validateParallelDispatch(batch, waves), true);
});

test('validateParallelDispatch rejects batch with tasks from different waves', () => {
  const waves = new Map([
    ['A', 0],
    ['B', 1],
  ]);
  const batch = [
    { id: 'A', depends_on: [], files: ['file1.ts'] },
    { id: 'B', depends_on: ['A'], files: ['file2.ts'] },
  ];
  const result = validateParallelDispatch(batch, waves);
  assert.notEqual(result, true);
  assert.ok(result.includes('different waves'));
});

test('validateParallelDispatch rejects batch with overlapping files', () => {
  const waves = new Map([
    ['A', 0],
    ['B', 0],
  ]);
  const batch = [
    { id: 'A', depends_on: [], files: ['shared.ts'] },
    { id: 'B', depends_on: [], files: ['shared.ts'] },
  ];
  const result = validateParallelDispatch(batch, waves);
  assert.notEqual(result, true);
  assert.ok(result.includes('shared.ts'));
});

test('validateParallelDispatch rejects task with dependency in same or later wave', () => {
  const waves = new Map([
    ['A', 1],
    ['B', 1],
  ]);
  const batch = [
    { id: 'A', depends_on: ['B'], files: ['file1.ts'] },
    { id: 'B', depends_on: [], files: ['file2.ts'] },
  ];
  const result = validateParallelDispatch(batch, waves);
  assert.notEqual(result, true);
  assert.ok(result.includes('not in an earlier wave'));
});

test('validateParallelDispatch rejects task not in wave map', () => {
  const waves = new Map([['A', 0]]);
  const batch = [
    { id: 'X', depends_on: [], files: ['file1.ts'] },
  ];
  const result = validateParallelDispatch(batch, waves);
  assert.notEqual(result, true);
  assert.ok(result.includes('no wave assignment'));
});

test('validateParallelDispatch rejects empty batch', () => {
  assert.throws(() => validateParallelDispatch([], new Map()), /non-empty/i);
});

test('maxParallelism returns the size of the largest wave', () => {
  const waves = new Map([
    ['A', 0],
    ['B', 0],
    ['C', 0],
    ['D', 1],
    ['E', 1],
    ['F', 2],
  ]);
  assert.equal(maxParallelism(waves), 3);
});

test('maxParallelism returns 0 for empty waves', () => {
  assert.equal(maxParallelism(new Map()), 0);
});

test('maxParallelism returns 1 for purely sequential plan', () => {
  const waves = new Map([
    ['A', 0],
    ['B', 1],
    ['C', 2],
  ]);
  assert.equal(maxParallelism(waves), 1);
});

test('checkFanOutFloor returns meets=true when parallelism >= floor', () => {
  const waves = new Map([
    ['A', 0], ['B', 0], ['C', 0], ['D', 0], ['E', 0],
    ['F', 0], ['G', 0], ['H', 0], ['I', 0], ['J', 0],
  ]);
  const result = checkFanOutFloor(waves, 10);
  assert.equal(result.meets, true);
  assert.equal(result.maxParallelism, 10);
  assert.equal(result.suggestion, '');
});

test('checkFanOutFloor returns meets=false when parallelism < floor', () => {
  const waves = new Map([
    ['A', 0], ['B', 0], ['C', 0],
  ]);
  const result = checkFanOutFloor(waves, 10);
  assert.equal(result.meets, false);
  assert.equal(result.maxParallelism, 3);
  assert.ok(result.suggestion.includes('below the 10-subagent floor'));
});

test('checkFanOutFloor uses custom floor', () => {
  const waves = new Map([
    ['A', 0], ['B', 0], ['C', 0],
  ]);
  const result = checkFanOutFloor(waves, 2);
  assert.equal(result.meets, true);
  assert.equal(result.maxParallelism, 3);
});
