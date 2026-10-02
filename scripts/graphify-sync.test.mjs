// scripts/graphify-sync.test.mjs
//
// Guards for the end-of-session sync that registers this repository's Markdown
// in its own graphify graph.
//
// The two properties worth testing are the two that are invisible from the
// outside. The first is that a re-run is a no-op: `structural()` is
// deterministic and `merge()` is a union keyed on node id, so syncing twice must
// produce byte-identical graphs — otherwise every session's end would rewrite a
// multi-megabyte file and the "is the graph current?" check could never be green.
// The second is that the graphify-era document ids already in the graph are
// remapped onto this layer's ids instead of being duplicated, because the
// failure mode of getting that wrong is a second node for every known file and
// an orphaned first one, which no count anywhere reports.
//
// The tests run against a temporary root, so they never touch the real graph and
// never depend on graphify or the network.

import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  buildDocIdBySourceFile,
  planSync,
  gateVerdict,
  toRepoRelative,
} from './graphify-sync.mjs';
import { serializeGraph } from './vault-index-merge.mjs';

/** A throwaway root with the named files written. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'graphify-sync-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return root;
}

const NOTE = `---
title: Session handoff
---

# Session handoff

## Next action

Continue the pipeline. See [[other-note]].
`;

const OTHER = `# Other note

Body.
`;

/** A previous graph carrying the code graph plus one already-known document. */
function previousGraph() {
  return {
    directed: false,
    multigraph: false,
    graph: { hyperedges: [] },
    nodes: [
      { id: 'code_foo', label: 'foo', file_type: 'code', source_file: 'scripts/x.mjs' },
      // The id this layer would NOT choose, so the remap path is exercised.
      { id: 'graphify_era_handoff', label: 'Session handoff', file_type: 'document', source_file: 'docs/handoff.md' },
      { id: 'concept--c', label: 'A claim', file_type: 'concept', source_file: 'docs/handoff.md' },
    ],
    links: [{ source: 'concept--c', target: 'graphify_era_handoff', relation: 'mentions', confidence: 'INFERRED' }],
    built_at_commit: 'deadbeef',
  };
}

describe('buildDocIdBySourceFile', () => {
  test('maps a source_file to its document node, never to a heading node', () => {
    const chunks = [
      {
        chunk: {
          nodes: [
            { id: 'doc_for_x', file_type: 'document', node_kind: 'document', source_file: 'x.md' },
            { id: 'heading_under_x', file_type: 'document', node_kind: 'heading', source_file: 'x.md' },
          ],
        },
      },
    ];
    const map = buildDocIdBySourceFile(chunks);
    expect(map.get('x.md')).toBe('doc_for_x');
  });

  test('ignores a non-document node citing the same file', () => {
    const map = buildDocIdBySourceFile([
      { chunk: { nodes: [{ id: 'c1', file_type: 'concept', source_file: 'x.md' }] } },
    ]);
    expect(map.has('x.md')).toBe(false);
  });
});

describe('planSync', () => {
  test('adds a document node and its headings for a new note', () => {
    const root = fixture({ 'docs/handoff.md': NOTE });
    try {
      const { graph, structuralReport } = planSync({ root, files: ['docs/handoff.md'], previous: previousGraph() });
      const doc = graph.nodes.find((n) => n.node_kind === 'document' && n.source_file === 'docs/handoff.md');
      expect(doc).toBeTruthy();
      expect(doc.label).toBe('Session handoff');
      expect(structuralReport.noSourceFile).toBe(0);
      expect(graph.nodes.length).toBeGreaterThan(previousGraph().nodes.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('remaps an existing document id instead of duplicating the file', () => {
    const root = fixture({ 'docs/handoff.md': NOTE });
    try {
      const { graph, normalization } = planSync({ root, files: ['docs/handoff.md'], previous: previousGraph() });
      const docs = graph.nodes.filter((n) => n.file_type === 'document' && n.source_file === 'docs/handoff.md' && n.node_kind !== 'heading');
      expect(docs.length).toBe(1);
      expect(docs[0].id).not.toBe('graphify_era_handoff');
      expect(normalization.documentIdsRemapped).toBe(1);
      // The concept's edge followed the remap rather than dangling.
      expect(graph.links.some((l) => l.source === 'concept--c' && l.target === docs[0].id)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('is idempotent: a second run over its own output is byte-identical', () => {
    const root = fixture({ 'docs/handoff.md': NOTE, 'docs/other.md': OTHER });
    try {
      const files = ['docs/handoff.md', 'docs/other.md'];
      const first = planSync({ root, files, previous: previousGraph() }).graph;
      const second = planSync({ root, files, previous: first }).graph;
      expect(serializeGraph(second)).toBe(serializeGraph(first));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains every previous code, concept and rationale node', () => {
    const root = fixture({ 'docs/handoff.md': NOTE });
    try {
      const { graph } = planSync({ root, files: ['docs/handoff.md'], previous: previousGraph() });
      expect(graph.nodes.some((n) => n.id === 'code_foo')).toBe(true);
      expect(graph.nodes.some((n) => n.id === 'concept--c')).toBe(true);
      expect(graph.built_at_commit).toBe('deadbeef');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gateVerdict', () => {
  test('passes when the union grows or holds', () => {
    expect(gateVerdict({ nodes: [{ id: 'a' }, { id: 'b' }] }, { nodes: [{ id: 'a' }] }).pass).toBe(true);
    expect(gateVerdict({ nodes: [{ id: 'a' }] }, { nodes: [{ id: 'a' }] }).pass).toBe(true);
  });

  test('refuses when the union would lose a node', () => {
    expect(gateVerdict({ nodes: [] }, { nodes: [{ id: 'a' }] }).pass).toBe(false);
  });
});

describe('toRepoRelative', () => {
  test('relativises an absolute path and trusts a relative one', () => {
    expect(toRepoRelative('/repo', '/repo/docs/a.md')).toBe('docs/a.md');
    expect(toRepoRelative('/repo', 'docs/a.md')).toBe('docs/a.md');
  });
});
