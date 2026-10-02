// scripts/lib/chunk-schema.test.mjs
//
// Guards for the contract that every parallel extraction subagent's output is
// held to before it is allowed to become part of a knowledge graph.
//
// The property under test is NOT "the chunk parses". JSON.parse already tells
// you that. The property is that every edge in the chunk points at something
// that exists — either in the same chunk or in a set the caller declared from
// other chunks. That sounds obvious enough that its absence looks like a
// formatting nit, and it is not: an edge with an unresolvable endpoint is
// written into graph.json as-is, and the graph loader that later reads the file
// has no way to tell it apart from a good edge. The failure is silent, total,
// and invisible in every count except the one nobody checks — orphan nodes.
//
// So the tests below are weighted towards the endpoints, not the vocabularies.
// A bad `relation` string produces a graph that renders a nonsense label on
// one edge; a bad endpoint produces a node that nothing can ever reach. The
// first is visible the moment somebody looks. The second is the defect this
// module exists to make impossible.
//
// Two design choices are asserted here rather than argued for in prose,
// because both are the kind of thing that survives review and then quietly
// does the wrong thing at scale:
//
//   1. VALIDATION IS EXHAUSTIVE AND NON-THROWING. A chunk with nine bad nodes
//      reports nine errors, not one. A validator that stops at the first
//      failure forces a subagent — which may be fifty seconds of model latency
//      away from the fix — through nine separate round trips to discover nine
//      separate mistakes. It also must not throw on `null`: the caller is a
//      JSON parser's output and null is an ordinary value for it to hold.
//
//   2. CROSS-CHUNK REFERENCES ARE LEGAL BUT DECLARED. A parallel extraction
//      cannot know the ids another subagent invented, so links that leave the
//      chunk are expected. They are checked against `opts.knownNodeIds`, which
//      means a reference either resolves against a declaration the caller
//      actually holds, or it is an error. That is what lets the later merge
//      report a resolution rate instead of a hope: `stats.crossChunk` counts
//      the endpoints that came in from outside, and the merge either finds
//      those ids or it does not.
//
// The vocabularies are copied from a measured graph.json, not from a
// document, which is why they are pinned by an exact-deepEqual assertion: a
// relation silently dropped from RELATIONS turns every edge using it into a
// validation failure at extraction time, and a relation silently ADDED lets a
// typo through as a new edge type that nothing downstream has ever heard of.

import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  FILE_TYPES,
  RELATIONS,
  CONFIDENCES,
  validateChunk,
} from './chunk-schema.mjs';

// ---------- fixtures ----------

// A node needs four fields to pass and nothing else: the id and label are
// identity, file_type and source_file are the two the validator can check
// without reading the repository. Everything else the real graph carries
// (community, norm_label, _origin, confidence_score) is assigned by a later
// pass that owns those decisions, so requiring them here would make every
// subagent invent a community number it has no way to know.
function node(overrides = {}) {
  return {
    id: 'a',
    label: 'Alpha',
    file_type: 'code',
    source_file: 'src/alpha.ts',
    ...overrides,
  };
}

function link(overrides = {}) {
  return {
    source: 'a',
    target: 'b',
    relation: 'calls',
    confidence: 'EXTRACTED',
    ...overrides,
  };
}

// Two nodes and one link between them: the smallest thing that exercises the
// endpoint check at all. A single-node chunk cannot, because a link needs two
// ends and a self-link would not be a realistic fixture.
function valid() {
  return {
    nodes: [node(), node({ id: 'b', label: 'Beta', source_file: 'src/beta.ts' })],
    links: [link()],
  };
}

// valid() with one extra link whose fields are overridden. Every link test goes
// through here rather than reaching into the links array, so a change to the
// node fixture cannot silently turn a link test into a node test.
function withLink(overrides) {
  const chunk = valid();
  chunk.links.push(link(overrides));
  return chunk;
}

// The error name is the part before the first colon. Comparing whole messages
// would make every test here a hostage to wording, and wording is exactly the
// thing a reader is allowed to improve later.
function names(result) {
  return result.errors.map((e) => e.slice(0, e.indexOf(':') < 0 ? e.length : e.indexOf(':')));
}

function assertHas(result, name) {
  expect(names(result)).toContain(name);
}

// ---------- 1. the minimal valid chunk ----------

describe('a minimal valid chunk', () => {
  test('passes with no errors', () => {
    const r = validateChunk(valid());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('reports stats that count what it accepted', () => {
    const r = validateChunk(valid());
    expect(r.stats.nodes).toBe(2);
    expect(r.stats.links).toBe(1);
    expect(r.stats.byFileType).toEqual({ code: 2 });
    expect(r.stats.byRelation).toEqual({ calls: 1 });
    expect(r.stats.dangling).toBe(0);
    expect(r.stats.crossChunk).toBe(0);
  });

  test('an empty chunk is valid — nothing wrong is different from nothing', () => {
    const r = validateChunk({ nodes: [], links: [] });
    expect(r.ok).toBe(true);
    expect(r.stats.nodes).toBe(0);
    expect(r.stats.links).toBe(0);
  });

  test('stats are computed even when the chunk is rejected', () => {
    // A subagent that gets nine errors needs to know how much it got right,
    // or its next attempt is a guess. Refusing to count a broken chunk is the
    // same mistake as refusing to report the errors.
    const r = validateChunk({
      nodes: [node({ id: 'a', file_type: 'widget' }), node({ id: 'b', source_file: '/etc/passwd' })],
      links: [link({ target: 'nope', relation: 'calls' })],
    });
    expect(r.ok).toBe(false);
    expect(r.stats.nodes).toBe(2);
    expect(r.stats.links).toBe(1);
    expect(r.stats.byFileType).toEqual({ code: 1, widget: 1 });
  });
});

// ---------- 2. the tables are pinned to a measured graph ----------

describe('the vocabularies', () => {
  test('FILE_TYPES is exactly the five values measured in graph.json', () => {
    expect(FILE_TYPES).toEqual(['code', 'concept', 'rationale', 'document', 'paper']);
  });

  test('RELATIONS is exactly the relation vocabulary measured in graph.json', () => {
    // Order is alphabetical so the table diffs cleanly when a relation is
    // added; the content is what matters, and this assertion is what makes a
    // silent drop or a silent addition fail the build instead of the graph.
    expect(RELATIONS).toEqual([
      'cites',
      'calls',
      'conceptually_related_to',
      'contains',
      'defines',
      'depends_on',
      'implements',
      'imports',
      'imports_from',
      'method',
      'rationale_for',
      'references',
      'semantically_similar_to',
      'shares_data_with',
    ]);
  });

  test('CONFIDENCES is exactly the three values measured in graph.json', () => {
    expect(CONFIDENCES).toEqual(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);
  });

  test('every table is frozen, so a caller cannot widen the contract in place', () => {
    // The validator closes over these at call time. A mutable table is a
    // module-level global that a test — or an optimistic caller — can loosen
    // for every later call in the same process, which is the opposite of a
    // contract.
    for (const t of [FILE_TYPES, RELATIONS, CONFIDENCES]) {
      expect(Object.isFrozen(t)).toBe(true);
      expect(() => t.push('nope')).toThrow();
    }
  });
});

// ---------- 3. nodes ----------

describe('node identity', () => {
  test('rejects a missing, empty, or non-string id', () => {
    for (const id of [undefined, null, '', '   ', 42, {}, ['a']]) {
      assertHas(validateChunk({ nodes: [node({ id })], links: [] }), 'node-id-invalid');
    }
  });

  test('rejects a missing, empty, or non-string label', () => {
    for (const label of [undefined, null, '', '  ', 7]) {
      assertHas(validateChunk({ nodes: [node({ label })], links: [] }), 'node-label-invalid');
    }
  });

  test('rejects a non-object node', () => {
    for (const n of [null, undefined, 'node', 42, []]) {
      assertHas(validateChunk({ nodes: [n], links: [] }), 'node-not-object');
    }
  });

  test('names the offending index, so the message is actionable', () => {
    const r = validateChunk({
      nodes: [node(), node({ id: 'b' }), node({ id: 'c', label: '' })],
      links: [],
    });
    const hit = r.errors.find((e) => e.startsWith('node-label-invalid'));
    expect(hit).toContain('nodes[2]');
  });

  test('rejects a duplicate node id inside one chunk', () => {
    const r = validateChunk({
      nodes: [node({ id: 'a', label: 'First' }), node({ id: 'a', label: 'Second' })],
      links: [],
    });
    assertHas(r, 'node-duplicate-id');
    expect(r.ok).toBe(false);
  });
});

describe('node file_type', () => {
  test('rejects an unknown file_type', () => {
    for (const file_type of ['widget', 'Code', 'CODE', 'note', '', null]) {
      assertHas(validateChunk({ nodes: [node({ file_type })], links: [] }), 'node-file-type-invalid');
    }
  });

  test('accepts every value in FILE_TYPES', () => {
    const r = validateChunk({
      nodes: FILE_TYPES.map((ft, i) => node({ id: `n${i}`, file_type: ft })),
      links: [],
    });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.stats.byFileType).sort()).toEqual([...FILE_TYPES].sort());
  });
});

describe('node source_file must be repo-relative', () => {
  // This is the one check in the module that is not about graph semantics at
  // all. A source_file is written to disk later, next to the notes it came
  // from, and an extractor that read a file outside the repo — or was handed
  // one by a document that merely mentioned a path — can otherwise aim the
  // writer at an arbitrary location. Rejecting the shape here means the writer
  // downstream never has to be the thing that notices.

  test('rejects an absolute path', () => {
    for (const source_file of ['/etc/passwd', '/home/someone/.ssh/id_rsa', '/']) {
      assertHas(validateChunk({ nodes: [node({ source_file })], links: [] }), 'node-source-file-absolute');
    }
  });

  test('rejects a Windows drive path and a UNC path', () => {
    for (const source_file of ['C:\\Windows\\system32', 'D:/data/x.ts', '\\\\server\\share\\x']) {
      assertHas(validateChunk({ nodes: [node({ source_file })], links: [] }), 'node-source-file-absolute');
    }
  });

  test('rejects any ".." segment', () => {
    for (const source_file of ['../outside.ts', '../../etc/passwd', 'src/../../escape.ts', 'a/b/../../../c']) {
      assertHas(validateChunk({ nodes: [node({ source_file })], links: [] }), 'node-source-file-traversal');
    }
  });

  test('rejects ".." in a backslash-separated path too', () => {
    assertHas(
      validateChunk({ nodes: [node({ source_file: 'src\\..\\..\\escape.ts' })], links: [] }),
      'node-source-file-traversal',
    );
  });

  test('does not mistake a filename that merely contains dots for traversal', () => {
    // The rule is about SEGMENTS, not substrings. A file legitimately named
    // `a..b.ts` exists, and a validator that greps for '..' rejects it while
    // still catching nothing new, which is how a check gets disabled later.
    for (const source_file of ['src/a..b.ts', 'notes/2024..2025.md', 'weird..name/']) {
      const r = validateChunk({ nodes: [node({ source_file })], links: [] });
      expect(r.errors).toEqual([]);
    }
  });

  test('rejects an empty, whitespace-only, or non-string source_file', () => {
    for (const source_file of [undefined, null, '', '   ', 42]) {
      assertHas(validateChunk({ nodes: [node({ source_file })], links: [] }), 'node-source-file-invalid');
    }
  });

  test('accepts ordinary repo-relative paths, including dotfiles and deep paths', () => {
    for (const source_file of [
      'src/lib/thing.ts',
      'scripts/lib/deeply/nested/file.mjs',
      '.github/workflows/ci.yml',
      'docs/a/b/c.md',
    ]) {
      const r = validateChunk({ nodes: [node({ source_file })], links: [] });
      expect(r.errors).toEqual([]);
    }
  });
});

// ---------- 4. link endpoints: the reason this module exists ----------

describe('link endpoints must resolve', () => {
  test('rejects an endpoint that is neither in the chunk nor declared', () => {
    const r = validateChunk(
      {
        nodes: [node({ id: 'a' })],
        links: [link({ source: 'a', target: 'never-declared' })],
      },
      { knownNodeIds: new Set(['some-other-chunk-id']) },
    );
    assertHas(r, 'dangling-endpoint');
    expect(r.ok).toBe(false);
    expect(r.stats.dangling).toBe(1);
  });

  test('names the link index and which end failed', () => {
    const chunk = valid();
    chunk.links.push(link({ source: 'ghost', target: 'b' }));
    const r = validateChunk(chunk, { knownNodeIds: new Set() });
    const hit = r.errors.find((e) => e.startsWith('dangling-endpoint'));
    expect(hit).toContain('links[1]');
    expect(hit).toContain('source');
  });

  test('accepts an endpoint declared by another chunk and counts it', () => {
    // This is the whole reason knownNodeIds exists. A parallel subagent cannot
    // see the ids a sibling invented, so a link leaving the chunk is normal —
    // but it is only normal when the caller can prove the other end exists.
    const r = validateChunk(
      {
        nodes: [node({ id: 'a' })],
        links: [link({ source: 'a', target: 'elsewhere' })],
      },
      { knownNodeIds: new Set(['elsewhere', 'and-more']) },
    );
    expect(r.ok).toBe(true);
    expect(r.stats.crossChunk).toBe(1);
    expect(r.stats.dangling).toBe(0);
  });

  test('an endpoint in the chunk wins over knownNodeIds', () => {
    // The chunk's own nodes are added to the resolution set, never subtracted
    // from it. A duplicate id across chunks is a merge problem to report, not
    // a reason for this chunk's own edge to stop resolving.
    const r = validateChunk(valid(), { knownNodeIds: new Set(['a', 'b']) });
    expect(r.ok).toBe(true);
    expect(r.stats.crossChunk).toBe(0);
  });

  test('counts each unresolvable endpoint once, even in a two-ended failure', () => {
    const r = validateChunk(
      { nodes: [], links: [link({ source: 'x', target: 'y' })] },
      { knownNodeIds: new Set() },
    );
    expect(r.stats.dangling).toBe(2);
    expect(names(r).filter((n) => n === 'dangling-endpoint')).toHaveLength(2);
  });

  test('performs no endpoint check when knownNodeIds is omitted', () => {
    // Documented behaviour, not an oversight: with nothing to check against,
    // every endpoint would dangle and the report would be noise. The caller
    // that cannot supply the set is the caller that gets stats.crossChunk = 0
    // and must resolve ids itself at merge time.
    const r = validateChunk({
      nodes: [node({ id: 'a' })],
      links: [link({ target: 'not-here' })],
    });
    expect(r.errors).toEqual([]);
    expect(r.stats.dangling).toBe(0);
  });

  test('rejects a Set that is not a Set, rather than treating it as empty', () => {
    // An array of ids passed where a Set was expected is a caller bug. Reading
    // it as "no known ids" would silently disable the check this module exists
    // to perform, and the graph would come out orphaned again.
    expect(() => validateChunk(valid(), { knownNodeIds: ['b'] })).toThrow(TypeError);
    expect(() => validateChunk(valid(), { knownNodeIds: new Set() })).not.toThrow();
  });
});

// ---------- 5. link vocabulary and duplicates ----------

describe('link vocabulary', () => {
  test('rejects an unknown relation', () => {
    for (const relation of ['mentions', 'CALLS', 'imports_from ', '', null]) {
      assertHas(validateChunk(withLink({ relation }), { knownNodeIds: new Set() }), 'link-relation-invalid');
    }
  });

  test('rejects an unknown confidence', () => {
    for (const confidence of ['HIGH', 'extracted', 'MAYBE', '', null]) {
      assertHas(validateChunk(withLink({ confidence }), { knownNodeIds: new Set() }), 'link-confidence-invalid');
    }
  });

  test('accepts every value in RELATIONS and CONFIDENCES', () => {
    const r = validateChunk(
      {
        nodes: [node({ id: 'a' }), node({ id: 'b' })],
        links: RELATIONS.map((relation, i) =>
          link({ relation, confidence: CONFIDENCES[i % CONFIDENCES.length] }),
        ),
      },
      {},
    );
    expect(r.ok).toBe(true);
    expect(Object.keys(r.stats.byRelation).sort()).toEqual([...RELATIONS].sort());
  });

  test('rejects an empty or non-string source and target', () => {
    for (const bad of [undefined, null, '', '  ', 42]) {
      assertHas(validateChunk(withLink({ source: bad }), { knownNodeIds: new Set() }), 'link-source-invalid');
      assertHas(validateChunk(withLink({ target: bad }), { knownNodeIds: new Set() }), 'link-target-invalid');
    }
  });

  test('rejects a non-object link', () => {
    for (const l of [null, undefined, 'link', 42]) {
      assertHas(validateChunk({ nodes: valid().nodes, links: [l] }), 'link-not-object');
    }
  });

  test('rejects an exact duplicate link inside one chunk', () => {
    // Keyed on source|target|relation, so a repeated edge with a different
    // confidence is still a duplicate — that is a disagreement between two
    // extractors about the same fact, and resolving it by keeping both is how
    // a multigraph quietly becomes a weighted bag.
    const r = validateChunk({
      nodes: valid().nodes,
      links: [link(), link()],
    });
    assertHas(r, 'link-duplicate');
    expect(r.ok).toBe(false);
  });

  test('the same source|target with a different relation is not a duplicate', () => {
    const r = validateChunk({
      nodes: valid().nodes,
      links: [link({ relation: 'calls' }), link({ relation: 'references' })],
    });
    expect(r.ok).toBe(true);
  });

  test('a reversed edge is not a duplicate of its forward twin', () => {
    const r = validateChunk({
      nodes: valid().nodes,
      links: [link({ source: 'a', target: 'b' }), link({ source: 'b', target: 'a' })],
    });
    expect(r.ok).toBe(true);
  });
});

// ---------- 6. top-level shape ----------

describe('top-level shape', () => {
  test('rejects nodes that is not an array', () => {
    for (const nodes of [undefined, null, {}, 'nodes', 42, new Set()]) {
      const r = validateChunk({ nodes, links: [] });
      assertHas(r, 'nodes-not-array');
      expect(r.ok).toBe(false);
    }
  });

  test('rejects links that is not an array', () => {
    for (const links of [undefined, null, {}, 'links', 42, new Set()]) {
      const r = validateChunk({ nodes: [], links });
      assertHas(r, 'links-not-array');
      expect(r.ok).toBe(false);
    }
  });

  test('rejects a chunk that is not an object, without throwing', () => {
    // The caller is a JSON parser's output. `null` is an ordinary value for it
    // to hold, and a validator that throws here takes down the whole merge
    // over one chunk's malformed output — the opposite of containment.
    for (const chunk of [null, undefined, 'chunk', 42, true, []]) {
      const r = validateChunk(chunk);
      expect(r.ok).toBe(false);
      assertHas(r, 'chunk-not-object');
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  test('reports every violation rather than stopping at the first', () => {
    // One subagent, one fix. Reporting nine errors means the round trip costs
    // one model turn instead of nine, and it means a chunk with one bad
    // vocabulary value and eight dangling edges does not get "fixed" eight
    // times over with the vocabulary error surviving until last.
    const r = validateChunk({
      nodes: [node({ id: '', file_type: 'widget', source_file: '/abs' })],
      links: [link({ relation: 'nope', confidence: 'nope' })],
    });
    const seen = names(r);
    for (const n of ['node-id-invalid', 'node-file-type-invalid', 'node-source-file-absolute', 'link-relation-invalid', 'link-confidence-invalid']) {
      expect(seen).toContain(n);
    }
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------- 7. the module stays pure ----------

describe('the validator itself', () => {
  test('does not mutate the chunk it was handed', () => {
    const chunk = valid();
    const before = JSON.stringify(chunk);
    validateChunk(chunk, { knownNodeIds: new Set(['x']) });
    expect(JSON.stringify(chunk)).toBe(before);
  });

  test('is pure: it cannot write, and it has no clock or randomness', () => {
    // A validator that reads the filesystem or the clock is a validator whose
    // verdict depends on something the caller cannot see in the report. The
    // module also has no imports at all beyond its own file, which is the
    // cheapest possible proof that there is nowhere for a hidden dependency
    // to hide.
    const src = readFileSync(new URL('./chunk-schema.mjs', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from\s+'node:/);
    expect(src).not.toMatch(/from\s+['"][^.]/);
    expect(src).not.toMatch(/\b(?:readFile|writeFile|appendFile|createWriteStream|mkdir|rename|unlink)\b/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bDate\b/);
    expect(src).not.toMatch(/Math\.random/);
  });
});