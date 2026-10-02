import { test, expect, describe } from 'bun:test';
import {
  buildIdBySourceFile,
  normalizePreviousIds,
  degreeZero,
  gateVerdict,
} from './vault-index-rebuild.mjs';

const doc = (id, source_file) => ({ id, file_type: 'document', source_file });

describe('buildIdBySourceFile', () => {
  test('indexes only document nodes, by source_file', () => {
    const chunks = [
      { chunk: { nodes: [doc('a', 'x.md'), { id: 'c1', file_type: 'concept', source_file: 'x.md' }] } },
      { chunk: { nodes: [doc('b', 'y.md')] } },
    ];
    const m = buildIdBySourceFile(chunks);
    expect(m.get('x.md')).toBe('a');
    expect(m.get('y.md')).toBe('b');
    expect(m.size).toBe(2);
  });

  test('first document id wins on a repeated source_file', () => {
    const m = buildIdBySourceFile([
      { chunk: { nodes: [doc('first', 'x.md')] } },
      { chunk: { nodes: [doc('second', 'x.md')] } },
    ]);
    expect(m.get('x.md')).toBe('first');
  });
});

describe('normalizePreviousIds', () => {
  test('remaps a document id and rewrites its links', () => {
    const previous = {
      nodes: [doc('old_doc', 'notes/x.md'), { id: 'concept--c', file_type: 'concept', source_file: 'notes/x.md' }],
      links: [{ source: 'old_doc', target: 'concept--c', relation: 'mentions' }],
    };
    const { previous: out, report } = normalizePreviousIds(previous, new Map([['notes/x.md', 'notes_x']]));
    expect(out.nodes.find((n) => n.id === 'notes_x')).toBeTruthy();
    expect(out.nodes.some((n) => n.id === 'old_doc')).toBe(false);
    expect(out.links[0].source).toBe('notes_x');
    expect(report.documentIdsRemapped).toBe(1);
    expect(report.linksRewritten).toBe(1);
  });

  test('never remaps a non-document node, even when it cites the same file', () => {
    const previous = {
      nodes: [{ id: 'concept--c', file_type: 'concept', source_file: 'notes/x.md' }],
      links: [],
    };
    const { previous: out, report } = normalizePreviousIds(previous, new Map([['notes/x.md', 'notes_x']]));
    expect(out.nodes[0].id).toBe('concept--c');
    expect(report.documentIdsRemapped).toBe(0);
  });

  test('collapses two documents that map to one id', () => {
    const previous = {
      nodes: [doc('a', 'x.md'), { ...doc('b', 'x.md'), label: 'filled' }],
      links: [{ source: 'a', target: 'b', relation: 'rel' }],
    };
    const { previous: out, report } = normalizePreviousIds(previous, new Map([['x.md', 'x']]));
    expect(out.nodes.length).toBe(1);
    expect(report.nodesCollapsed).toBe(1);
    // the edge between the two fused nodes becomes a self-loop and is dropped
    expect(report.selfLoopsDropped).toBe(1);
    expect(out.links.length).toBe(0);
  });

  test('is a no-op (same object) when nothing maps', () => {
    const previous = { nodes: [doc('a', 'x.md')], links: [] };
    const { previous: out, report } = normalizePreviousIds(previous, new Map());
    expect(out).toBe(previous);
    expect(report.documentIdsRemapped).toBe(0);
  });

  test('does not mutate the input', () => {
    const previous = { nodes: [doc('a', 'x.md')], links: [] };
    normalizePreviousIds(previous, new Map([['x.md', 'x']]));
    expect(previous.nodes[0].id).toBe('a');
  });
});

describe('degreeZero', () => {
  test('counts nodes absent from every endpoint', () => {
    const graph = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      links: [{ source: 'a', target: 'b' }],
    };
    expect(degreeZero(graph)).toBe(1);
  });
});

describe('gateVerdict', () => {
  test('passes when nodes do not shrink and degree-0 falls', () => {
    const previous = { nodes: [{ id: 'a' }, { id: 'b' }], links: [] };
    const graph = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], links: [{ source: 'a', target: 'c' }] };
    const v = gateVerdict(graph, previous);
    expect(v.pass).toBe(true);
    expect(v.d0Before).toBe(2);
    expect(v.d0After).toBe(1);
  });

  test('fails when degree-0 rises, even if nodes grow', () => {
    const previous = { nodes: [{ id: 'a' }], links: [{ source: 'a', target: 'z' }] };
    const graph = { nodes: [{ id: 'a' }, { id: 'b' }], links: [{ source: 'a', target: 'z' }] };
    const v = gateVerdict(graph, previous);
    expect(v.pass).toBe(false);
    expect(v.d0After).toBe(1);
    expect(v.d0Before).toBe(0);
  });
});
