// scripts/lib/chunk-schema.mjs
//
// The one contract every parallel extraction subagent's output is held to
// before any of it is allowed to become part of a knowledge graph.
//
// The property being defended is not "the chunk parses" — a JSON parser already
// establishes that, and a schema that only checks shape has already failed at
// the only job it had. The property is that every edge in the chunk terminates
// at a node that exists: in this chunk, or in a set the caller declared from
// chunks it has already collected. That is a small sentence with a large
// consequence. A dangling endpoint is not an error a downstream consumer can
// detect. It is written into graph.json as a perfectly well-formed edge object
// — source is a string, relation is a string, confidence is a string — and the
// loader that reads the file back has no signal that distinguishes it from a
// good edge. The symptom surfaces much later and somewhere else entirely: a
// node count in the thousands, an edge count of zero or near-zero, and every
// node an orphan. Nothing in between fails. A file that parses, a schema that
// validates, a writer that succeeds, and a graph with no structure in it are
// all the same silent outcome.
//
// So the checks are weighted by how quietly they fail, not by how often they
// fire. An unrecognised `relation` string produces an edge labelled with a
// nonsense word, which a person notices the first time they open the graph. An
// unresolvable endpoint produces a node nothing can reach, which nobody notices
// until the graph is useless. Same class of mistake, same cost of one line of
// code, wildly different cost of being missed.
//
// Three properties of the validator itself are part of the contract:
//
//   1. IT NEVER THROWS ON BAD DATA. The input is whatever a JSON parser handed
//      back, and `null` is an ordinary value for that to be. A validator that
//      throws takes down the entire merge over one malformed chunk, which is
//      the opposite of containment: the single bad subagent would deny the
//      work of all the good ones. The one exception is a `knownNodeIds` that is
//      not a Set — that is a caller bug in the harness, not extracted data, and
//      silently treating an array of ids as "no known ids" would disable the
//      exact check this module exists to perform.
//
//   2. IT IS EXHAUSTIVE. Every violation in a chunk is reported, not the first
//      one. The consumer is a model that will fix the chunk and resubmit, and
//      each resubmit is expensive. Discovering nine errors nine times over costs
//      nine round trips and, worse, hides the vocabulary error under the eight
//      dangling edges until the very last attempt.
//
//   3. IT IS PURE. No filesystem, no clock, no randomness, no imports at all.
//      A verdict that depends on something the caller cannot see in the report
//      is not reproducible, and the merge is the place where being unable to
//      reproduce a rejection is most expensive.
//
// The three vocabularies below were transcribed from an actual
// graphify-out/graph.json — measured with jq over the node and link arrays, not
// copied from prose — and are frozen, because they are the one thing here that
// must not drift. A relation silently dropped from the table turns every edge
// that uses it into an extraction failure; a relation silently added lets a
// typo through as a novel edge type that no consumer has ever seen. Both are
// far more expensive than a test asserting the table's exact contents.
//
// One field carries an unrelated but non-negotiable rule. `source_file` is
// written to disk later, beside the notes it describes, so it is required to be
// repo-relative: no leading slash, no drive letter, no UNC prefix, and no `..`
// segment. An extractor that read a file outside the repository — or was handed
// a path by a document that merely mentioned one — would otherwise aim the
// writer at an arbitrary location, and the check has to live at the layer that
// sees the string, because by the time something writes it the origin is gone.
// The traversal rule is about path SEGMENTS, not the two-character substring:
// `src/a..b.ts` is a real filename and must pass, because a check that rejects
// it while catching nothing new is a check somebody eventually deletes.

/**
 * Every `file_type` a node may carry. Sorted by nothing in particular; the
 * order is the order they were listed when measured, and the tests pin it.
 */
export const FILE_TYPES = Object.freeze(['code', 'concept', 'rationale', 'document', 'paper']);

/**
 * Every `relation` a link may carry, alphabetised so the table diffs cleanly
 * when a relation is added. Alphabetical is a choice, not a fact about the
 * data: it means a new relation lands in a position a reader expects instead
 * of at the end of a list whose order nobody has ever relied on.
 */
export const RELATIONS = Object.freeze([
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

/**
 * Every `confidence` a link may carry. Ordering is meaningful — EXTRACTED is
 * stronger than INFERRED, which is stronger than AMBIGUOUS — so this list is
 * deliberately NOT alphabetical. Do not "tidy" it.
 */
export const CONFIDENCES = Object.freeze(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);

// Sets for membership tests. Built once from the frozen arrays rather than
// stored alongside them, so there is exactly one source of truth for what the
// vocabularies contain and no way for a set to fall out of sync with its list.
const FILE_TYPE_SET = new Set(FILE_TYPES);
const RELATION_SET = new Set(RELATIONS);
const CONFIDENCE_SET = new Set(CONFIDENCES);

// Endpoint keys are joined on a character that cannot appear in a node id, so
// two different (source, target) pairs can never collide into one duplicate.
const KEY_SEP = '\u0000';

/** A string that is non-empty once trimmed. */
function isFilledString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Render a value for an error message without letting an object become "[object Object]". */
function show(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Is this a path that aims outside the repository?
 *
 * Split on both separators because an extractor that emitted Windows paths is
 * exactly the case where a forward-slash-only check would let `..\..\` through.
 * Checking segments rather than substrings is what keeps `a..b.ts` valid.
 */
function pathProblem(value) {
  if (!isFilledString(value)) return 'node-source-file-invalid';
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
    return 'node-source-file-absolute';
  }
  if (value.split(/[\\/]+/).includes('..')) return 'node-source-file-traversal';
  return null;
}

/** An empty stats object, so a rejected chunk still reports what it could count. */
function emptyStats() {
  return { nodes: 0, links: 0, byFileType: {}, byRelation: {}, dangling: 0, crossChunk: 0 };
}

/**
 * Validate one extraction chunk against the graphify graph schema.
 *
 * Never throws on extracted data — malformed input is the expected case, and
 * every violation comes back in `errors` so a caller can show all of them at
 * once. The single throw is for a `knownNodeIds` that is not a Set, because
 * that is a harness bug rather than data and quietly degrading from it would
 * disable the check.
 *
 * Endpoint resolution is conditional on `knownNodeIds` being supplied. A caller
 * that omits it cannot check anything, so no endpoint is called dangling —
 * `stats.crossChunk` is 0 and the caller owns resolution at merge time. That is
 * documented behaviour with a consequence, not a default to be relied on
 * silently: a merge that forgets the Set gets no dangling reports at all.
 *
 * @param {{ nodes?: unknown, links?: unknown }} chunk
 * @param {{ knownNodeIds?: Set<string> }} [opts]
 * @returns {{ ok: boolean, errors: string[], stats: { nodes: number, links: number,
 *   byFileType: Record<string, number>, byRelation: Record<string, number>,
 *   dangling: number, crossChunk: number } }}
 */
export function validateChunk(chunk, opts = {}) {
  const errors = [];
  const stats = emptyStats();

  if (opts.knownNodeIds !== undefined && !(opts.knownNodeIds instanceof Set)) {
    throw new TypeError(`knownNodeIds must be a Set of node ids, got ${typeof opts.knownNodeIds}`);
  }
  const knownNodeIds = opts.knownNodeIds;

  if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) {
    errors.push('chunk-not-object: a chunk must be an object with nodes and links arrays');
    return { ok: false, errors, stats };
  }

  // ---------- top level ----------

  const nodes = chunk.nodes;
  const links = chunk.links;
  const nodesOk = Array.isArray(nodes);
  const linksOk = Array.isArray(links);
  if (!nodesOk) errors.push('nodes-not-array: chunk.nodes must be an array');
  if (!linksOk) errors.push('links-not-array: chunk.links must be an array');

  // ---------- nodes ----------

  // Populated even when a node is otherwise malformed, because a duplicate id
  // is still a duplicate whether or not the node carrying it has a valid
  // source_file. Building the id set from whatever ids were usable also means
  // the endpoint pass below has a resolution base even for a broken chunk.
  const ownIds = new Set();
  if (nodesOk) {
    stats.nodes = nodes.length;
    nodes.forEach((n, i) => {
      if (n === null || typeof n !== 'object' || Array.isArray(n)) {
        errors.push(`node-not-object: nodes[${i}] must be an object, got ${show(n)}`);
        return;
      }
      // file_type is counted before it is judged, so byFileType explains what
      // arrived — including the unknown value — instead of quietly omitting it.
      if (typeof n.file_type === 'string') {
        stats.byFileType[n.file_type] = (stats.byFileType[n.file_type] ?? 0) + 1;
      }

      if (!isFilledString(n.id)) {
        errors.push(`node-id-invalid: nodes[${i}].id must be a non-empty string, got ${show(n.id)}`);
      } else if (ownIds.has(n.id)) {
        errors.push(`node-duplicate-id: nodes[${i}].id ${JSON.stringify(n.id)} already appears in this chunk`);
      } else {
        ownIds.add(n.id);
      }

      if (!isFilledString(n.label)) {
        errors.push(`node-label-invalid: nodes[${i}].label must be a non-empty string, got ${show(n.label)}`);
      }

      if (typeof n.file_type !== 'string' || !FILE_TYPE_SET.has(n.file_type)) {
        errors.push(
          `node-file-type-invalid: nodes[${i}].file_type ${show(n.file_type)} is not one of ${FILE_TYPES.join(', ')}`,
        );
      }

      // A bad path is reported as exactly one error: a missing source_file is
      // not also an absolute path, and stacking all three would read as three
      // separate fixes for one mistake.
      const pathError = pathProblem(n.source_file);
      if (pathError) {
        errors.push(`${pathError}: nodes[${i}].source_file ${show(n.source_file)} is not a repo-relative path`);
      }
    });
  }

  // ---------- links ----------

  // Keyed on source|target|relation. Confidence is excluded on purpose: two
  // extractors disagreeing about the confidence of the same edge is a
  // disagreement to report, not two edges. A self-referential pair with two
  // different relations is a different claim and is allowed.
  const seenLinkKeys = new Set();
  if (linksOk) {
    stats.links = links.length;
    links.forEach((l, i) => {
      if (l === null || typeof l !== 'object' || Array.isArray(l)) {
        errors.push(`link-not-object: links[${i}] must be an object, got ${show(l)}`);
        return;
      }
      if (typeof l.relation === 'string') {
        stats.byRelation[l.relation] = (stats.byRelation[l.relation] ?? 0) + 1;
      }

      const sourceOk = isFilledString(l.source);
      const targetOk = isFilledString(l.target);
      if (!sourceOk) {
        errors.push(`link-source-invalid: links[${i}].source must be a non-empty string, got ${show(l.source)}`);
      }
      if (!targetOk) {
        errors.push(`link-target-invalid: links[${i}].target must be a non-empty string, got ${show(l.target)}`);
      }

      if (typeof l.relation !== 'string' || !RELATION_SET.has(l.relation)) {
        errors.push(
          `link-relation-invalid: links[${i}].relation ${show(l.relation)} is not one of ${RELATIONS.join(', ')}`,
        );
      }
      if (typeof l.confidence !== 'string' || !CONFIDENCE_SET.has(l.confidence)) {
        errors.push(
          `link-confidence-invalid: links[${i}].confidence ${show(l.confidence)} is not one of ${CONFIDENCES.join(', ')}`,
        );
      }

      if (sourceOk && targetOk) {
        const key = [l.source, l.target, String(l.relation)].join(KEY_SEP);
        if (seenLinkKeys.has(key)) {
          errors.push(
            `link-duplicate: links[${i}] repeats ${JSON.stringify(l.source)} -[${String(l.relation)}]-> ${JSON.stringify(l.target)} earlier in this chunk`,
          );
        } else {
          seenLinkKeys.add(key);
        }
      }

      // Endpoints are only judged when the caller supplied the ids to judge
      // them against. An endpoint that is not a usable string is already
      // reported above; counting it as dangling as well would double-report
      // one mistake.
      if (knownNodeIds === undefined) return;
      for (const [end, value] of [['source', l.source], ['target', l.target]]) {
        if (!isFilledString(value)) continue;
        if (ownIds.has(value)) continue;
        if (knownNodeIds.has(value)) {
          stats.crossChunk += 1;
          continue;
        }
        stats.dangling += 1;
        errors.push(
          `dangling-endpoint: links[${i}].${end} ${JSON.stringify(value)} is neither a node in this chunk nor declared in knownNodeIds`,
        );
      }
    });
  }

  return { ok: errors.length === 0, errors, stats };
}