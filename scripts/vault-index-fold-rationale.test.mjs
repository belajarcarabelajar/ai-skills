import { test, expect, describe } from 'bun:test';
import { foldChunk, renderRationale } from './vault-index-fold-rationale.mjs';

const concept = (id, extra = {}) => ({
  id,
  label: `label for ${id}`,
  file_type: 'concept',
  source_file: 'notes/a.md',
  source_location: 'L10',
  ...extra,
});

const rationale = (id, extra = {}) => ({
  id,
  label: `reason text for ${id}`,
  file_type: 'rationale',
  source_file: 'notes/a.md',
  source_location: 'L42',
  ...extra,
});

describe('renderRationale', () => {
  test('keeps the anchor so the claim stays traceable', () => {
    // The entire point of this project is that a claim can be traced to a line.
    // A fold that kept only the prose would destroy 771 anchors silently.
    const r = renderRationale(rationale('r1'));
    expect(r).toBe('[notes/a.md:L42] reason text for r1');
  });

  test('falls back through label, summary, description', () => {
    expect(renderRationale({ file_type: 'rationale', label: 'from label' })).toBe('from label');
    expect(renderRationale({ file_type: 'rationale', summary: 'from summary' })).toBe('from summary');
    expect(renderRationale({ file_type: 'rationale', description: 'from desc' })).toBe('from desc');
  });

  test('returns null when there is no usable text at all', () => {
    // An attribute with no text is worse than an honest gap, because it looks
    // sourced while saying nothing.
    expect(renderRationale({ file_type: 'rationale', label: '  ' })).toBe(null);
    expect(renderRationale({ file_type: 'rationale' })).toBe(null);
  });

  test('degrades the anchor when only one half is present', () => {
    expect(renderRationale({ label: 'x', source_file: 'f.md' })).toBe('[f.md] x');
    expect(renderRationale({ label: 'x', source_location: 'L9' })).toBe('[L9] x');
    expect(renderRationale({ label: 'x' })).toBe('x');
  });
});

describe('foldChunk', () => {
  test('folds the why onto its target and removes both node and edge', () => {
    const { chunk, folded } = foldChunk({
      nodes: [concept('c1'), rationale('r1')],
      links: [{ relation: 'rationale_for', source: 'r1', target: 'c1' }],
    });
    expect(folded).toBe(1);
    expect(chunk.nodes.map((n) => n.id)).toEqual(['c1']);
    expect(chunk.links).toEqual([]);
    expect(chunk.nodes[0].rationale).toBe('[notes/a.md:L42] reason text for r1');
  });

  test('two rationales for one concept become an array, never one concatenated sentence', () => {
    // Concatenating would paraphrase away the fact that there were two separate
    // reasons, which is itself part of the claim.
    const { chunk } = foldChunk({
      nodes: [concept('c1'), rationale('r1'), rationale('r2')],
      links: [
        { relation: 'rationale_for', source: 'r1', target: 'c1' },
        { relation: 'rationale_for', source: 'r2', target: 'c1' },
      ],
    });
    expect(Array.isArray(chunk.nodes[0].rationale)).toBe(true);
    expect(chunk.nodes[0].rationale).toHaveLength(2);
  });

  test('a rationale already stored as an attribute is not clobbered', () => {
    const { chunk } = foldChunk({
      nodes: [concept('c1', { rationale: 'pre-existing' }), rationale('r1')],
      links: [{ relation: 'rationale_for', source: 'r1', target: 'c1' }],
    });
    expect(chunk.nodes[0].rationale).toEqual(['pre-existing', '[notes/a.md:L42] reason text for r1']);
  });

  test('an unattached rationale node is KEPT, not deleted', () => {
    // Deleting it would be the exact silent-loss failure this project keeps
    // fighting. Report it instead.
    const { chunk, unattached } = foldChunk({
      nodes: [concept('c1'), rationale('orphan')],
      links: [],
    });
    expect(unattached).toEqual(['orphan']);
    expect(chunk.nodes.map((n) => n.id).sort()).toEqual(['c1', 'orphan']);
  });

  test('a rationale pointing at a missing target is kept and reported', () => {
    const { chunk, unattached } = foldChunk({
      nodes: [rationale('r1')],
      links: [{ relation: 'rationale_for', source: 'r1', target: 'nope' }],
    });
    expect(unattached).toEqual(['r1']);
    expect(chunk.nodes).toHaveLength(1);
  });

  test('a rationale with no text is kept and reported rather than emptied', () => {
    const { chunk, unattached } = foldChunk({
      nodes: [concept('c1'), { id: 'r1', label: '  ', file_type: 'rationale' }],
      links: [{ relation: 'rationale_for', source: 'r1', target: 'c1' }],
    });
    expect(unattached).toEqual(['r1']);
    expect(chunk.nodes.map((n) => n.id).sort()).toEqual(['c1', 'r1']);
  });

  test('one rationale explaining two concepts folds into both', () => {
    const { chunk, folded } = foldChunk({
      nodes: [concept('c1'), concept('c2'), rationale('r1')],
      links: [
        { relation: 'rationale_for', source: 'r1', target: 'c1' },
        { relation: 'rationale_for', source: 'r1', target: 'c2' },
      ],
    });
    expect(folded).toBe(2);
    expect(chunk.nodes).toHaveLength(2);
    expect(chunk.nodes[0].rationale).toBeTruthy();
    expect(chunk.nodes[1].rationale).toBeTruthy();
  });

  test('an unresolvable rationale_for edge is preserved and reported, not deleted', () => {
    // r1 is not in nodes at all. That is a pre-existing extractor defect, not
    // something this fold caused -- deleting it would destroy the evidence
    // that an edge was ever dangling. It survives and is counted.
    const { chunk, danglingEdges } = foldChunk({
      nodes: [concept('c1'), concept('c2'), rationale('loner')],
      links: [
        { relation: 'rationale_for', source: 'r1', target: 'c1' },
        { relation: 'conceptually_related_to', source: 'c1', target: 'c2' },
      ],
    });
    expect(danglingEdges).toEqual(['r1']);
    expect(chunk.links.map((l) => l.relation)).toEqual([
      'rationale_for',
      'conceptually_related_to',
    ]);
    expect(chunk.nodes.map((n) => n.id)).toContain('loner');
  });

  test('an edge is removed exactly when its source node was folded away', () => {
    // The pair that must hold: no rationale_for outlives the node it named.
    const { chunk } = foldChunk({
      nodes: [concept('c1'), rationale('r1')],
      links: [{ relation: 'rationale_for', source: 'r1', target: 'c1' }],
    });
    expect(chunk.links.filter((l) => l.relation === 'rationale_for')).toHaveLength(0);
    expect(chunk.nodes.filter((n) => n.file_type === 'rationale')).toHaveLength(0);
  });

  test('a chunk with no rationales is returned unchanged', () => {
    const input = { nodes: [concept('c1'), concept('c2')], links: [] };
    const { chunk, folded } = foldChunk(input);
    expect(folded).toBe(0);
    expect(chunk.nodes).toHaveLength(2);
  });

  test('missing nodes/links arrays do not throw', () => {
    expect(() => foldChunk({})).not.toThrow();
    expect(foldChunk({}).chunk.nodes).toEqual([]);
  });

  test('provenance keys at the top level survive the fold', () => {
    const { chunk } = foldChunk({
      batch: 'rem-999',
      vault_root: '/x',
      nodes: [concept('c1'), rationale('r1')],
      links: [{ relation: 'rationale_for', source: 'r1', target: 'c1' }],
    });
    expect(chunk.batch).toBe('rem-999');
    expect(chunk.vault_root).toBe('/x');
  });
});