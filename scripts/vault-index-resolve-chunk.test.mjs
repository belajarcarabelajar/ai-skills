// scripts/vault-index-resolve-chunk.test.mjs
//
// The resolver exists because a hand-typed transcript path is silent: it makes
// `check-anchors.mjs` skip a node's anchors and still print `0 failed`. The
// property under test is therefore not "the path string changes" but "no path in
// the output is anything other than an exact string from the batch manifest",
// and "an unresolvable path is an error, never a passthrough".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChunk } from './vault-index-resolve-chunk.mjs';

const FILES = [
  '05 - Conversations/proyek/2026-09-26 - c6b-today-tomorrow [ses_f20bd3368ffeljwsaRfEE14jNZ].md',
  '05 - Conversations/other/2026-10-02 - fix-rust-logging [ses_f05d64c03ffebpGvwknTWSTC1U].md',
  '01 - Projects/Snipset/plans/2026-09-04-feature-request-form.md',
];

test('resolves a basename source_file to the exact batch path', () => {
  const { chunk, errors } = resolveChunk(
    { nodes: [{ id: 'concept--x', source_file: '2026-09-04-feature-request-form.md', file_type: 'concept', label: 'X' }], links: [] },
    FILES,
  );
  assert.deepEqual(errors, []);
  assert.equal(chunk.nodes[0].source_file, '01 - Projects/Snipset/plans/2026-09-04-feature-request-form.md');
});

test('resolves @SELFFILE@ anchors and basename anchors to exact paths', () => {
  const rel = '05 - Conversations/proyek/2026-09-26 - c6b-today-tomorrow [ses_f20bd3368ffeljwsaRfEE14jNZ].md';
  const node = {
    id: 'concept--x',
    source_file: '2026-09-26 - c6b-today-tomorrow [ses_f20bd3368ffeljwsaRfEE14jNZ].md',
    file_type: 'concept',
    label: 'X',
    source_location: 'L10',
    rationale: `[@SELFFILE@:L10] the note's own words`,
  };
  const other = {
    id: 'concept--y',
    source_file: rel,
    file_type: 'concept',
    label: 'Y',
    source_location: 'L4',
    rationale: `[2026-10-02 - fix-rust-logging [ses_f05d64c03ffebpGvwknTWSTC1U].md:L4] second file`,
  };
  const { chunk, errors } = resolveChunk({ nodes: [node, other], links: [] }, FILES);
  assert.deepEqual(errors, []);
  assert.equal(chunk.nodes[0].rationale, `[${rel}:L10] the note's own words`);
  assert.equal(
    chunk.nodes[1].rationale,
    `[05 - Conversations/other/2026-10-02 - fix-rust-logging [ses_f05d64c03ffebpGvwknTWSTC1U].md:L4] second file`,
  );
});

test('an exact full path passes through unchanged (idempotent)', () => {
  const rel = FILES[2];
  const { chunk, errors } = resolveChunk(
    { nodes: [{ id: 'concept--x', source_file: rel, file_type: 'concept', label: 'X', rationale: `[${rel}:L2] q` }], links: [] },
    FILES,
  );
  assert.deepEqual(errors, []);
  assert.equal(chunk.nodes[0].source_file, rel);
  assert.equal(chunk.nodes[0].rationale, `[${rel}:L2] q`);
});

test('an unknown source_file is an error, never a passthrough', () => {
  const { errors } = resolveChunk(
    { nodes: [{ id: 'concept--x', source_file: 'typed-by-hand.md', file_type: 'concept', label: 'X' }], links: [] },
    FILES,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not in this batch/);
});

test('an unknown anchor path is an error', () => {
  const { errors } = resolveChunk(
    {
      nodes: [{
        id: 'concept--x',
        source_file: FILES[0],
        file_type: 'concept',
        label: 'X',
        rationale: '[a-file-that-never-shipped.md:L9] q',
      }],
      links: [],
    },
    FILES,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /anchor.*not in this batch/);
});

test('a duplicate basename in the batch is reported, not silently picked', () => {
  const dupes = ['a/note.md', 'b/note.md'];
  const { errors } = resolveChunk(
    { nodes: [{ id: 'concept--x', source_file: 'note.md', file_type: 'concept', label: 'X' }], links: [] },
    dupes,
  );
  assert.ok(errors.some((e) => /duplicate basename/.test(e)));
});

test('the node count and resolved count are reported', () => {
  const { resolved, nodes } = resolveChunk(
    { nodes: [
      { id: 'concept--a', source_file: FILES[0], file_type: 'concept', label: 'A' },
      { id: 'concept--b', source_file: FILES[2], file_type: 'concept', label: 'B' },
    ], links: [] },
    FILES,
  );
  assert.equal(nodes, 2);
  assert.equal(resolved, 2);
});
