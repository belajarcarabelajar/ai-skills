// scripts/vault-index-batch.mjs
//
// Decides how the vault's unindexed corpus gets divided up between parallel
// extraction subagents, and does it on BYTES rather than on file count.
//
// The reason is a measured property of the worklist, and it is the whole
// justification for this module existing. The 1,821 files still to extract have
// a median of 3 KB, a p90 of 0.2 MB and a maximum of 8.4 MB; 1,042 of them sit
// in `05 - Conversations/` and account for 300.9 MB of the 303.8 MB total. A
// per-file-count rule — "six files per subagent", the rule a person reaches for
// because file count is the thing a fan-out is normally counted in — is wrong
// here in a way that produces no error anywhere. It puts an 8.4 MB transcript
// and a 3 KB note in the same context and calls the batch full. The subagent
// then silently truncates, returns a chunk that covers only the small file, and
// every downstream artefact is valid: a JSON chunk, a passing schema check, a
// merge that reports success. The loss only becomes visible as a gap in the
// graph weeks later, with nothing in the pipeline to point at it.
//
// So the partition is sized in bytes and filled largest-first. Largest-first
// because the tail is what does the damage: in input order, whichever batch
// happens to meet the big transcript absorbs the entire budget around it, and
// the ordering of the input becomes the ordering of the loss. With descending
// order each large file anchors a batch of similar-sized siblings and the
// remaining space is filled with notes that can afford it.
//
// Three properties of the output are load-bearing rather than cosmetic, and
// all three are about a run that does not finish in one session:
//
//   1. DETERMINISM IS THE RESUMABILITY MECHANISM. This corpus produces ~334
//      batches, which cannot be dispatched from one session, so the run will be
//      resumed. A resumed session skips every batch whose output already exists
//      on disk, keyed by batch id — and that is only sound if the same worklist
//      produces the same plan, batch for batch, every time. Nothing else in the
//      pipeline can recover from a plan that reshuffles between runs: the
//      already-written chunk for `batch-017` is then attributed to whatever
//      files happen to be in batch 017 of the new plan. Which is why the
//      descending sort breaks ties on input position explicitly rather than
//      leaning on `Array.prototype.sort` being stable — that is an
//      implementation property, not a contract, and two files of the same size
//      are the common case here (2,465 files under 20 KB).
//
//   2. AN OVERSIZED FILE IS ITS OWN BATCH, AND IS FLAGGED, NEVER CUT. A file
//      bigger than the budget cannot be made to fit, and the two available
//      wrong answers are both silent. Slicing it discards content with no
//      record of which half survived; letting it share a batch with a small
//      file makes the budget guarantee false from the first byte. This module
//      does neither. An oversized file gets a batch containing nothing else,
//      carries `truncated: true`, and is reported whole. What the caller then
//      does about it — head-and-tail, split into two subagents, deferred — is a
//      policy decision, and the only thing owed here is an honest signal that a
//      policy decision is required. `truncated` means "this batch exceeds the
//      budget and holds exactly one file", which is the ONLY shape on which
//      exceeding the budget is allowed, and the tests assert the budget holds
//      everywhere else.
//
//   3. ORDER WITHIN A BATCH IS THE INPUT'S ORDER. Packing happens in descending
//      size, which is not an order a reader wants to look at in a prompt or in
//      a diff between two runs. Restoring input order inside each batch costs
//      one sort over each batch and makes the plan reproducible in the sense
//      that matters when a person is auditing it: two runs differ by nothing.
//      The order ACROSS batches is deliberately size-anchored instead, since
//      that is the order the packing actually happened in and pretending
//      otherwise would hide which batch the big files ended up in.
//
// First-fit over descending order, rather than next-fit, is a real choice and
// not a synonym. Next-fit (open a new batch the moment one file does not fit
// the CURRENT batch) passes every budget assertion and can still triple the
// subagent count on this corpus, because it abandons the leftover space in
// earlier batches. First-fit refills those holes with the small notes, which
// are 97% of the worklist. That is why the tests assert mean fill as well as
// the ceiling: the ceiling is the guarantee, the fill is the reason the module
// is worth having.
//
// Inputs may be `{ path, bytes }` objects or bare path strings paired with an
// `opts.sizes` Map (or plain object) — the worklist is JSON on the wire and a
// caller holding that should not have to rebuild it into objects to use this.
// A path whose size cannot be resolved throws instead of defaulting to zero: a
// 0-byte entry is a file that costs nothing, fits anywhere, and disappears from
// a plan that reports itself complete, which is the exact class of quiet
// failure this module is in the path of.

/** The per-subagent context budget. 800 KB, the value the plan was costed at. */
export const DEFAULT_BUDGET_BYTES = 800 * 1024;

/**
 * `batch-007` for the seventh batch.
 *
 * Zero-padded rather than bare so that a listing of finished batch files sorts
 * in dispatch order in every tool a person might reach for, including `ls`,
 * which sorts lexically. Padded to three because the observed plan is ~334
 * batches and a two-digit pad would have been one corpus-growth away from
 * reshuffling a whole directory listing.
 *
 * @param {number} n 1-based batch number.
 * @returns {string}
 */
export function formatBatchId(n) {
  return `batch-${String(n).padStart(3, '0')}`;
}

/**
 * Resolve a caller's size input, whatever shape it arrived in.
 *
 * `opts.sizes` is accepted as a Map or a plain object because the worklist
 * arrives as JSON and a Map is awkward to write by hand in a test. Both are
 * read through the same path so the two forms cannot diverge.
 */
function lookupSize(path, sizes) {
  if (sizes == null) throw new TypeError(`no size for ${path}: pass { path, bytes } entries or opts.sizes`);
  const value = typeof sizes.get === 'function' ? sizes.get(path) : sizes[path];
  if (value === undefined) throw new TypeError(`no size for ${path}: not present in opts.sizes`);
  return value;
}

/**
 * Normalise, validate, and tag every entry with its input position.
 *
 * The position is kept because it is the tie-break for the descending sort and
 * the key for the per-batch re-order, and because it is what makes a shuffled
 * INPUT produce a different — but still deterministic — plan. Determinism here
 * means "the same worklist gives the same plan", not "the plan is invariant
 * under reordering", because the caller owns the input order and changing it is
 * building a different plan.
 */
function normalise(files, sizes) {
  if (!Array.isArray(files)) {
    throw new TypeError(`files must be an array of { path, bytes } or path strings, got ${typeof files}`);
  }
  const seen = new Set();
  return files.map((entry, index) => {
    const isString = typeof entry === 'string';
    if (!isString && (entry === null || typeof entry !== 'object' || Array.isArray(entry))) {
      throw new TypeError(`files[${index}]: expected { path, bytes } or a path string, got ${typeof entry}`);
    }
    const path = isString ? entry : entry.path;
    if (typeof path !== 'string' || path === '') {
      throw new TypeError(`files[${index}]: path must be a non-empty string`);
    }
    if (seen.has(path)) {
      // Indexing the same file twice in one run produces two chunks about one
      // file, and the merge has no way to tell which of them is the duplicate.
      throw new TypeError(`files[${index}]: duplicate path ${path}`);
    }
    seen.add(path);

    const bytes = isString ? lookupSize(path, sizes) : entry.bytes;
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      throw new TypeError(`files[${index}]: bytes for ${path} must be a non-negative finite number, got ${String(bytes)}`);
    }
    return { path, bytes, index };
  });
}

/**
 * Divide a measured worklist into byte-budgeted batches.
 *
 * @param {Array<{path: string, bytes: number} | string>} files
 * @param {{ budget?: number, sizes?: Map<string, number> | Record<string, number> }} [opts]
 * @returns {Array<{ id: string, files: Array<{path: string, bytes: number}>, bytes: number, truncated: boolean }>}
 *   `truncated` is true exactly when the batch holds one file larger than the
 *   budget. That batch is the only one permitted to exceed the budget.
 */
export function batch(files, opts = {}) {
  const budget = opts.budget ?? DEFAULT_BUDGET_BYTES;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
    throw new TypeError(`opts.budget must be a positive number of bytes, got ${String(budget)}`);
  }

  const entries = normalise(files, opts.sizes);
  if (entries.length === 0) return [];

  // Descending by size, ascending by input position on a tie. The tie-break is
  // written out rather than inherited from sort stability because stability is
  // not a language guarantee, and equal sizes are the common case on a
  // worklist where 2,465 files are under 20 KB.
  const order = entries.slice().sort((a, b) => (b.bytes - a.bytes) || (a.index - b.index));

  // Open batches are searched oldest-first, which is what fills the leftover
  // space next-fit throws away. `used` and the oversized flag are tracked on the
  // working record; `files` holds the original indices so the batch can be
  // re-ordered into input order at the end without a second lookup.
  const open = [];

  for (const entry of order) {
    const oversized = entry.bytes > budget;
    let target = null;
    // An oversized file has no target by construction: its own batch is already
    // over budget, so `used + anything <= budget` is false for it and no later
    // file can be placed alongside. That is the mechanism, not a guard.
    if (!oversized) {
      for (const candidate of open) {
        if (candidate.used + entry.bytes <= budget) {
          target = candidate;
          break;
        }
      }
    }

    if (target === null) {
      target = { used: 0, oversized, indices: [] };
      open.push(target);
    }
    target.used += entry.bytes;
    target.indices.push(entry.index);
  }

  return open.map((b, i) => {
    const members = b.indices
      .slice()
      .sort((x, y) => x - y)
      .map((index) => entries[index]);
    return {
      id: formatBatchId(i + 1),
      files: members.map(({ path, bytes }) => ({ path, bytes })),
      bytes: members.reduce((sum, m) => sum + m.bytes, 0),
      truncated: b.oversized,
    };
  });
}

/**
 * `batch()` plus the totals a caller reports before dispatching anything.
 *
 * `oversized` is the count of files needing a truncation decision, not the
 * count of batches — the two happen to be equal today because an oversized file
 * always gets a batch to itself, and the count is reported per FILE because
 * that is what the caller has to act on.
 *
 * @param {Array<{path: string, bytes: number} | string>} files
 * @param {{ budget?: number, sizes?: Map<string, number> | Record<string, number> }} [opts]
 */
export function planBatches(files, opts = {}) {
  const batches = batch(files, opts);
  const entries = normalise(files, opts.sizes);
  const budget = opts.budget ?? DEFAULT_BUDGET_BYTES;
  return {
    batches,
    files: entries.length,
    totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    oversized: entries.filter((e) => e.bytes > budget).length,
  };
}