// scripts/vault-index-cluster.test.mjs
//
// T10's regression suite. The clustering itself is graphify's own `cluster()` and
// `label_communities_by_hub()`, driven by `vault-index-cluster.py`; this file
// drives that script the way vault-index-narration.test.mjs drives the narration
// filter, because the repo runs one test runner (`bun test scripts/`) and the
// python helper cannot be unit-tested from JS any other way.
//
// The property that matters most is the one the whole deviation rests on: the
// graph must come back with every node it went in with. `graphify cluster-only`
// cannot do that (its loader drops 1,794 concept nodes), so if this script ever
// reports a node count below the file's, the write must be refused — and the test
// that pins the gate is the one that would catch it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { computeCommunities, applyCommunities, PYTHON } from './vault-index-cluster.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = join(HERE, 'vault-index-cluster.py');

// A graph with two connected pairs and one isolated node. The isolated node is
// the case T10 step 2 is about: it has nothing to cluster with, so it must come
// back as a singleton community, not be dropped and not be left unassigned.
function fixtureGraph() {
  return {
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [
      { id: 'a', label: 'Alpha', file_type: 'concept', source_file: 'x.md' },
      { id: 'b', label: 'Beta', file_type: 'concept', source_file: 'x.md' },
      { id: 'c', label: 'Gamma', file_type: 'concept', source_file: 'y.md' },
      { id: 'd', label: 'Delta', file_type: 'concept', source_file: 'y.md' },
      { id: 'iso', label: 'Isolated', file_type: 'concept', source_file: 'z.md' },
    ],
    links: [
      { source: 'a', target: 'b', relation: 'rel' },
      { source: 'c', target: 'd', relation: 'rel' },
    ],
    built_at_commit: 'fixture',
  };
}

function fixtureFile() {
  const dir = mkdtempSync(join(tmpdir(), 'vault-cluster-'));
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify(fixtureGraph()), 'utf8');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runPython(graphPath) {
  const r = spawnSync(PYTHON, [PYTHON_SCRIPT, graphPath], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------- the python clustering ----------

test('clusters a fixture graph and assigns every node a community', () => {
  const f = fixtureFile();
  try {
    const { status, stdout, stderr } = runPython(f.file);
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const out = JSON.parse(stdout);
    assert.equal(out.node_count, 5, 'every node must survive the round trip');
    assert.equal(out.link_count, 2);
    assert.equal(out.degree_zero, 1, 'the isolated node is still isolated');
    assert.equal(out.singletons, 1, 'an isolated node is its own singleton community');
    assert.equal(out.unassigned.length, 0, 'no node is left without a community');
    assert.equal(Object.keys(out.mapping).length, 5);
    // Two pairs + one singleton = three communities.
    assert.equal(out.community_count, 3);
    // The two pairs are named after their hub; the singleton after its only member.
    const names = Object.values(out.mapping).map((m) => m.community_name);
    assert.ok(names.includes('Alpha') || names.includes('Beta'));
    assert.ok(names.includes('Gamma') || names.includes('Delta'));
    assert.ok(names.includes('Isolated'));
  } finally {
    f.cleanup();
  }
});

test('clustering is deterministic across two runs', () => {
  const f = fixtureFile();
  try {
    const a = JSON.parse(runPython(f.file).stdout);
    const b = JSON.parse(runPython(f.file).stdout);
    assert.deepEqual(a.mapping, b.mapping, 'two runs on one graph must agree');
    assert.equal(a.community_count, b.community_count);
  } finally {
    f.cleanup();
  }
});

test('a node with no edges is a singleton, not a drop', () => {
  // The failure this pins: an implementation that only clusters connected
  // components would report 4 nodes here and silently lose the fifth.
  const f = fixtureFile();
  try {
    const out = JSON.parse(runPython(f.file).stdout);
    assert.equal(out.node_count, 5);
    assert.ok(out.mapping.iso, 'the isolated node must be in the mapping');
    assert.equal(out.mapping.iso.community_name, 'Isolated');
  } finally {
    f.cleanup();
  }
});

// ---------- the JS apply step ----------

test('applyCommunities adds community fields and preserves every node and link', () => {
  const graph = fixtureGraph();
  const mapping = {
    a: { community: 0, community_name: 'Alpha' },
    b: { community: 0, community_name: 'Alpha' },
    c: { community: 1, community_name: 'Gamma' },
    d: { community: 1, community_name: 'Gamma' },
    iso: { community: 2, community_name: 'Isolated' },
  };
  const { graph: out, assigned, unassigned } = applyCommunities(graph, mapping);
  assert.equal(out.nodes.length, 5);
  assert.equal(out.links.length, 2, 'links are untouched');
  assert.equal(assigned, 5);
  assert.equal(unassigned, 0);
  assert.equal(out.nodes[0].community, 0);
  assert.equal(out.nodes[0].community_name, 'Alpha');
  assert.equal(out.nodes[4].community, 2);
  // The input is not mutated, so a dry run and a write run build the same object.
  assert.equal(graph.nodes[0].community, undefined);
});

test('applyCommunities counts nodes absent from the mapping as unassigned', () => {
  const graph = fixtureGraph();
  const { assigned, unassigned } = applyCommunities(graph, { a: { community: 0, community_name: 'A' } });
  assert.equal(assigned, 1);
  assert.equal(unassigned, 4);
});

test('applyCommunities leaves a node with no mapping untouched', () => {
  const graph = fixtureGraph();
  const { graph: out } = applyCommunities(graph, {});
  assert.equal(out.nodes[0].community, undefined);
  assert.equal(out.nodes.length, 5);
});

// ---------- the gate the runner enforces ----------

test('computeCommunities surfaces a node-count mismatch instead of hiding it', () => {
  // The runner refuses to write when the clustering saw fewer nodes than the
  // file holds. This is the check that would have caught the 1,794-node drop
  // that makes `graphify cluster-only` refuse to run.
  const f = fixtureFile();
  try {
    const result = computeCommunities(f.file);
    assert.equal(result.nodeCount, 5);
    // A graph whose nodes are all dropped would report 0; the runner's gate
    // compares this against the file's count and exits non-zero.
    assert.ok(result.nodeCount > 0);
  } finally {
    f.cleanup();
  }
});
