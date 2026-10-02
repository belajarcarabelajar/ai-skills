// scripts/vault-index-batch.test.mjs
//
// Guards for the slicing arithmetic that decides how the vault's unindexed
// corpus gets divided up between parallel extraction subagents.
//
// The reason this module exists at all is a measured property of the worklist,
// not a preference. The 1,821 files still to extract have a median of 3 KB, a
// p90 of 0.2 MB, and a maximum of 8.4 MB, with 1,042 of them in
// `05 - Conversations/` alone. A per-file-count rule — "six files per subagent"
// — is the obvious way to divide that, and it is wrong in a way that produces
// no error at all: it puts an 8.4 MB transcript and a 3 KB note in the same
// context and calls the batch full. The subagent then silently truncates,
// returns a chunk covering only the small file, and the output is a valid JSON
// chunk about one twentieth of the batch. Nothing in the pipeline fails. The
// loss is only visible as a graph with a hole in it, weeks later.
//
// So partitioning is on BYTES, and it is LARGEST-FIRST. Largest-first because
// the tail is the problem: pack in input order and the first batch to meet a
// large transcript absorbs the whole budget's worth of context around it, and
// the ordering of the input becomes the ordering of the damage.
//
// Three properties of the returned plan are load-bearing and are asserted
// rather than argued for in prose:
//
//   1. DETERMINISM IS THE RESUMABILITY MECHANISM. A run of this produces ~334
//      batches dispatched over several sessions. Batch `id`s are zero-padded
//      and sequential so that a resumed session can skip every batch whose
//      output already exists on disk. That only works if the same input yields
//      the same plan — byte for byte, every time. Which is also why the sort
//      breaks ties on input position explicitly: `Array.prototype.sort` being
//      stable is an implementation property, not a guarantee anyone reading
//      this file would be able to verify, and a plan that reshuffles when two
//      files are the same size reshuffles which files a previous session
//      already indexed.
//
//   2. AN OVERSIZED FILE IS ITS OWN BATCH AND IS FLAGGED, NEVER CUT. A file
//      larger than the budget cannot be made to fit. The two tempting wrong
//      answers are to slice it (throwing away content with no record of which
//      half was kept) and to let it share a batch with a small file (so the
//      budget guarantee is a lie from the first byte). This module does
//      neither: the file gets a batch to itself carrying `truncated: true`, and
//      the CALLER decides how to head-and-tail it. What this module owes the
//      caller is an honest report, and an honest report is one that can exceed
//      the budget when, and only when, it is the single file in the batch.
//
//   3. ORDER WITHIN A BATCH IS THE INPUT'S ORDER. Packing happens in
//      descending size, which is not an order a reader wants to see in a
//      prompt or in a diff of two runs. Restoring input order per batch costs
//      one sort and makes the output reproducible in the only sense that
//      matters to a person auditing it: two runs differ by nothing at all.
//
// Fixtures are synthetic sizes, not files on disk. Nothing here reads the real
// vault, so the suite is machine-independent; the size DISTRIBUTION is quoted
// from the real worklist, and the "realistic mixed" test at the bottom asserts
// properties of the plan rather than a batch count, because the corpus grows
// between runs and a magic number would be a test that fails for a good reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_BUDGET_BYTES,
  batch,
  planBatches,
  formatBatchId,
} from './vault-index-batch.mjs';

// ---------- fixtures ----------

const KB = 1024;

/** A worklist entry in the object form the module is documented to accept. */
function f(path, bytes) {
  return { path, bytes };
}

/** Deterministic pseudo-sizes, so a failure is reproducible from the log. */
function sizedFiles(specs) {
  return specs.map(([path, bytes]) => f(path, bytes));
}

// ---------- the empty and degenerate cases ----------

test('an empty worklist produces no batches, not one empty batch', () => {
  assert.deepEqual(batch([], {}), []);
  assert.deepEqual(batch([], { budget: 10 }), []);
});

test('files that all fit under the budget collapse into a single batch', () => {
  const batches = batch(sizedFiles([['a.md', 300], ['b.md', 400]]), { budget: 1000 });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].bytes, 700);
  assert.equal(batches[0].truncated, false);
  assert.deepEqual(batches[0].files.map((x) => x.path), ['a.md', 'b.md']);
});

test('a zero-byte file still lands in a batch rather than vanishing', () => {
  const batches = batch(sizedFiles([['a.md', 0], ['b.md', 0]]), { budget: 1000 });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].files.length, 2);
});

// ---------- oversized files ----------

test('a file larger than the budget becomes its own batch, flagged truncated', () => {
  const batches = batch(sizedFiles([['big.md', 5000]]), { budget: 1000 });
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].files.map((x) => x.path), ['big.md']);
  assert.equal(batches[0].bytes, 5000);
  assert.equal(batches[0].truncated, true);
});

test('an oversized file is never merged with a small one, in either direction', () => {
  // Big first, then small — the naive "start a new batch, then keep filling"
  // implementation puts the 10-byte note in with the 5000-byte transcript.
  const bigFirst = batch(sizedFiles([['big.md', 5000], ['small.md', 10]]), { budget: 1000 });
  assert.equal(bigFirst.length, 2);
  assert.deepEqual(bigFirst[0].files.map((x) => x.path), ['big.md']);
  assert.deepEqual(bigFirst[1].files.map((x) => x.path), ['small.md']);

  // And the reverse order, because an implementation that sorts descending
  // only passes one of these by accident.
  const smallFirst = batch(sizedFiles([['small.md', 10], ['big.md', 5000]]), { budget: 1000 });
  assert.equal(smallFirst.length, 2);
  const big = smallFirst.find((x) => x.files.some((y) => y.path === 'big.md'));
  assert.deepEqual(big.files.map((x) => x.path), ['big.md']);
  assert.equal(big.truncated, true);
});

test('two oversized files become two batches, never one batch of two oversizes', () => {
  const batches = batch(sizedFiles([['a.md', 5000], ['b.md', 9000], ['c.md', 10]]), {
    budget: 1000,
  });
  assert.equal(batches.length, 3);
  for (const b of batches) {
    assert.equal(b.files.length, 1, `${b.id} holds ${b.files.length} files`);
  }
  assert.deepEqual(batches.map((b) => b.files[0].path), ['b.md', 'a.md', 'c.md']);
  assert.deepEqual(batches.map((b) => b.truncated), [true, true, false]);
});

test('an oversized file is still reported whole — the plan never slices content', () => {
  // The module's contract is that it flags, not cuts. If the reported bytes for
  // the oversized entry ever come back smaller than the file, something has
  // started truncating here and the caller's head-and-tail has been pre-empted.
  const size = 8.4 * 1024 * 1024;
  const batches = batch(sizedFiles([['transcript.md', size]]), {});
  assert.equal(batches[0].bytes, size);
  assert.equal(batches[0].files[0].bytes, size);
  assert.equal(batches[0].truncated, true);
});

// ---------- the budget guarantee ----------

test('no batch exceeds the budget except a batch holding a single oversized file', () => {
  // A deliberately awkward mix: sizes that straddle the budget so that a naive
  // first-fit-decreasing without a size check packs straight past it.
  const files = sizedFiles([
    ['a', 900],
    ['b', 900],
    ['c', 900],
    ['d', 400],
    ['e', 700],
    ['f', 200],
    ['g', 5000],
    ['h', 100],
    ['i', 950],
    ['j', 1],
  ]);
  const budget = 1000;
  const batches = batch(files, { budget });
  for (const b of batches) {
    if (b.files.length === 1) continue;
    assert.ok(
      b.bytes <= budget,
      `${b.id} holds ${b.files.length} files at ${b.bytes} bytes, over the ${budget} budget`,
    );
  }
  // Every file accounted for exactly once: no drop, no duplicate.
  const seen = batches.flatMap((b) => b.files.map((x) => x.path));
  assert.deepEqual([...seen].sort(), files.map((x) => x.path).sort());
});

test('a batch of one small file that somehow exceeds budget is reported truncated, not silently trusted', () => {
  // Defence in depth on the invariant: the flag is the caller's only signal
  // that a file needs head-and-tail treatment, so it must be true whenever a
  // batch is over budget — the single-file case is the only one permitted to
  // be, and it must announce itself.
  const batches = batch(sizedFiles([['x', 1001]]), { budget: 1000 });
  assert.equal(batches[0].truncated, true);
});

// ---------- exact-boundary rule ----------

test('EXACT BOUNDARY: a file that exactly fills the remaining budget IS placed', () => {
  // THE RULE: the budget is an inclusive ceiling. A batch may end AT the
  // budget and never above it, so `used + size === budget` fits and
  // `used + size > budget` does not. Greedily filling to exactly the limit is
  // correct here and only wastes context in the other direction — a rule that
  // stopped one byte short would refuse a 3 KB note to protect against a zero
  // byte of overflow, on a budget measured in hundreds of kilobytes.
  const batches = batch(sizedFiles([['a', 600], ['b', 400], ['c', 1]]), { budget: 1000 });
  assert.equal(batches.length, 2);
  assert.equal(batches[0].bytes, 1000, 'the 400-byte file exactly completes the 1000-byte budget');
  assert.equal(batches[0].truncated, false, 'exactly at the budget is not over it');
  assert.deepEqual(batches[0].files.map((x) => x.path), ['a', 'b']);
  assert.deepEqual(batches[1].files.map((x) => x.path), ['c']);
});

test('EXACT BOUNDARY: one byte over the remaining budget opens a new batch', () => {
  const batches = batch(sizedFiles([['a', 600], ['b', 401], ['c', 1]]), { budget: 1000 });
  assert.equal(batches.length, 2);
  for (const b of batches) {
    assert.ok(b.bytes <= 1000, `${b.id} is ${b.bytes} bytes`);
  }
  // 600+401 is one byte over, so they cannot share a batch. The 1-byte file
  // does go somewhere: first-fit refills the earlier hole rather than starting
  // a third batch, which is the behaviour that keeps the count near the
  // theoretical minimum instead of merely under the budget.
  const paths = batches.flatMap((x) => x.files.map((y) => y.path)).sort();
  assert.deepEqual(paths, ['a', 'b', 'c']);
  assert.equal(batches.filter((x) => x.files.some((y) => y.path === 'b')).length, 1);
});

test('EXACT BOUNDARY: a file exactly equal to the whole budget is a normal batch', () => {
  // `>` is the oversized test, not `>=`. Equal is not over, and flagging it
  // would send every exactly-budget file down the caller's truncation path for
  // no reason.
  const batches = batch(sizedFiles([['exact', 1000], ['other', 10]]), { budget: 1000 });
  assert.equal(batches[0].files[0].path, 'exact');
  assert.equal(batches[0].truncated, false);
  assert.equal(batches[1].files[0].path, 'other');
});

// ---------- determinism ----------

test('batch ids are zero-padded, sequential, and start at 001', () => {
  const files = sizedFiles([['a', 600], ['b', 401], ['c', 401], ['d', 401]]);
  const batches = batch(files, { budget: 1000 });
  assert.deepEqual(batches.map((x) => x.id), ['batch-001', 'batch-002', 'batch-003']);
});

test('formatBatchId pads to three digits and does not truncate past 999', () => {
  assert.equal(formatBatchId(1), 'batch-001');
  assert.equal(formatBatchId(9), 'batch-009');
  assert.equal(formatBatchId(10), 'batch-010');
  assert.equal(formatBatchId(100), 'batch-100');
  assert.equal(formatBatchId(999), 'batch-999');
  assert.equal(formatBatchId(1000), 'batch-1000');
  assert.equal(formatBatchId(1234), 'batch-1234');
});

test('two runs over the same input produce deep-equal plans', () => {
  // The resumability claim, stated as an assertion: batch N in a second run
  // must be the same batch N as in the first, or a resumed session re-indexes
  // work that already exists and skips work that does not.
  const files = sizedFiles([
    ['a', 5],
    ['b', 5],
    ['c', 5],
    ['big', 9000],
    ['d', 500],
    ['e', 500],
    ['f', 1],
  ]);
  const first = batch(files, { budget: 1000 });
  const second = batch(files.slice(), { budget: 1000 });
  assert.deepEqual(second, first);
});

test('a shuffled INPUT order reshuffles the plan — determinism is per input, not global', () => {
  // Documents the limit of the guarantee on purpose. Determinism means "the
  // same input gives the same plan", which is what a resumed run needs. It does
  // NOT mean the plan is independent of file ordering, because the file
  // ordering comes from a sorted worklist. A caller who reorders the worklist
  // is building a different plan, and pretending otherwise would be a claim
  // this module cannot make.
  const a = batch(sizedFiles([['a', 700], ['b', 700]]), { budget: 1000 });
  const b = batch(sizedFiles([['b', 700], ['a', 700]]), { budget: 1000 });
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
  assert.deepEqual(a[0].files.map((x) => x.path), ['a']);
  assert.deepEqual(b[0].files.map((x) => x.path), ['b']);
});

test('equal sizes do not reshuffle the plan', () => {
  // The tie-break is on input position, not on sort stability being assumed.
  const spec = [['a', 100], ['b', 100], ['c', 100], ['d', 100], ['e', 100], ['f', 100]];
  const first = batch(sizedFiles(spec), { budget: 300 });
  const second = batch(sizedFiles(spec), { budget: 300 });
  assert.deepEqual(first, second);
  assert.deepEqual(first[0].files.map((x) => x.path), ['a', 'b', 'c']);
});

// ---------- ordering within a batch ----------

test('files inside a batch follow INPUT order, not descending-size order', () => {
  const batches = batch(
    sizedFiles([['tiny', 100], ['big', 900], ['medium', 500], ['small', 300]]),
    { budget: 2000 },
  );
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].files.map((x) => x.path),
    ['tiny', 'big', 'medium', 'small'],
  );
});

test('input order is restored per batch, not globally', () => {
  // The three 900-byte files anchor three batches in descending order, and then
  // the three 10-byte files all go back into the FIRST batch, which still has
  // 100 bytes free. So batch 1 holds [a, d, e, f] — descending packing order
  // [a, d, e, f] happens to be input order here, but that is not what makes the
  // assertion below safe; the implementation re-sorts by input position
  // regardless, and the [b, d] case below is where it would show.
  const batches = batch(
    sizedFiles([['a', 900], ['b', 900], ['c', 900], ['d', 10], ['e', 10], ['f', 10]]),
    { budget: 1000 },
  );
  assert.equal(batches.length, 3);
  assert.deepEqual(batches[0].files.map((x) => x.path), ['a', 'd', 'e', 'f']);
  assert.deepEqual(batches[1].files.map((x) => x.path), ['b']);
  assert.deepEqual(batches[2].files.map((x) => x.path), ['c']);

  // Second case: `d` is first in the input and last in the packing stream, so
  // its batch can only come out as [d, a] if the batch really is re-sorted by
  // input position and not merely left in descending-size order.
  const mixed = batch(sizedFiles([['d', 10], ['a', 900], ['b', 900]]), { budget: 1000 });
  assert.deepEqual(mixed[0].files.map((x) => x.path), ['d', 'a']);
  assert.deepEqual(mixed[1].files.map((x) => x.path), ['b']);
});

// ---------- accepted input shapes ----------

test('plain paths plus opts.sizes is accepted and equal to the object form', () => {
  const paths = ['a.md', 'big.md', 'c.md'];
  const sizes = new Map([
    ['a.md', 10],
    ['big.md', 5000],
    ['c.md', 10],
  ]);
  const fromPaths = batch(paths, { budget: 1000, sizes });
  const fromObjects = batch(
    [
      f('a.md', 10),
      f('big.md', 5000),
      f('c.md', 10),
    ],
    { budget: 1000 },
  );
  assert.deepEqual(fromPaths, fromObjects);
});

test('opts.sizes also accepts a plain object, because the worklist is JSON', () => {
  const batches = batch(['a.md', 'b.md'], {
    budget: 1000,
    sizes: { 'a.md': 100, 'b.md': 200 },
  });
  assert.equal(batches[0].bytes, 300);
});

test('the input array is never mutated', () => {
  const files = sizedFiles([['a', 500], ['b', 500], ['c', 5000]]);
  const snapshot = JSON.parse(JSON.stringify(files));
  batch(files, { budget: 1000 });
  assert.deepEqual(JSON.parse(JSON.stringify(files)), snapshot);
});

// ---------- loud failures on caller bugs ----------

test('a missing size is an error, not a zero-byte file', () => {
  // A worklist entry whose size could not be looked up silently becomes a
  // 0-byte file that costs nothing and is packed anywhere. That is a file
  // quietly dropped from a plan that reports itself complete, which is the
  // whole class of failure this module is in the path of.
  assert.throws(() => batch(['a.md'], { sizes: new Map() }), /a\.md/);
  assert.throws(() => batch([f('a.md', -1)], {}), /bytes/);
  assert.throws(() => batch([f('a.md', Number.NaN)], {}), /bytes/);
  assert.throws(() => batch('a.md', {}), /array/i);
  assert.throws(() => batch([], { budget: 0 }), /budget/);
});

test('a duplicate path is reported rather than indexed twice', () => {
  assert.throws(() => batch(sizedFiles([['a', 1], ['a', 2]]), { budget: 100 }), /a/);
});

// ---------- planBatches ----------

test('planBatches returns the batches plus a summary that adds up', () => {
  const files = sizedFiles([['a', 400], ['b', 400], ['big', 9000]]);
  const plan = planBatches(files, { budget: 1000 });
  assert.equal(plan.files, 3);
  assert.equal(plan.totalBytes, 9800);
  assert.equal(plan.oversized, 1);
  assert.equal(plan.batches.length, 2);
  assert.deepEqual(plan.batches, batch(files, { budget: 1000 }));
  assert.deepEqual(Object.keys(plan).sort(), ['batches', 'files', 'oversized', 'totalBytes']);
});

test('planBatches over an empty worklist summarises to zeroes and no batches', () => {
  const plan = planBatches([], { budget: 1000 });
  assert.deepEqual(plan, { batches: [], files: 0, totalBytes: 0, oversized: 0 });
});

// ---------- the default budget, and the house rule that it is pinned ----------

test('DEFAULT_BUDGET_BYTES is 800 KB, the measured value, not a round guess', () => {
  // Read from the module rather than restated as a literal here, so a change is
  // visible as a diff instead of silently taking effect on 334 future batches.
  assert.equal(DEFAULT_BUDGET_BYTES, 800 * 1024);
  const body = readFileSync(new URL('./vault-index-batch.mjs', import.meta.url), 'utf8');
  assert.match(body, /export const DEFAULT_BUDGET_BYTES = 800 \* 1024;/);
});

test('the module imports nothing that can write or reach the network', () => {
  // The plan is computed from sizes the caller already measured. A batching
  // module that stats files itself would make the plan depend on the state of
  // the filesystem at plan time rather than on the worklist the caller holds,
  // which is exactly the kind of difference that makes a resumed run disagree
  // with the run it is resuming.
  const body = readFileSync(new URL('./vault-index-batch.mjs', import.meta.url), 'utf8');
  const imports = body.match(/^\s*import\s.+$/gm) ?? [];
  assert.deepEqual(imports, [], `unexpected imports:\n${imports.join('\n')}`);
  assert.doesNotMatch(body, /node:fs|node:child_process|fetch\(/);
});

// ---------- realistic mixed corpus ----------

test('a realistic mixed corpus packs to a plausible number of batches', () => {
  // Shapes taken from the measured worklist distribution: one 8.4 MB transcript,
  // a tail of ~200 KB files, a mass of ~3 KB notes. Asserted as PROPERTIES,
  // not as a batch count — the corpus grows, and a magic number here would be a
  // test that fails for a good reason.
  const files = [];
  files.push(f('05 - Conversations/huge.md', Math.round(8.4 * 1024 * 1024)));
  for (let i = 0; i < 20; i += 1) {
    files.push(f(`05 - Conversations/mid-${i}.md`, 200 * KB + (i % 7) * 1024));
  }
  for (let i = 0; i < 500; i += 1) {
    files.push(f(`notes/small-${i}.md`, 3 * KB + (i % 11) * 100));
  }

  const plan = planBatches(files, {});

  // 1. Nothing is lost or duplicated.
  assert.equal(plan.files, files.length);
  const paths = plan.batches.flatMap((x) => x.files.map((f2) => f2.path));
  assert.equal(paths.length, files.length);
  assert.equal(new Set(paths).size, files.length);

  // 2. The budget holds everywhere it is supposed to.
  const nonTruncated = plan.batches.filter((x) => !x.truncated);
  for (const x of nonTruncated) {
    assert.ok(x.bytes <= DEFAULT_BUDGET_BYTES, `${x.id} is ${x.bytes} bytes`);
  }

  // 3. The oversized transcript is alone in its own flagged batch.
  assert.equal(plan.oversized, 1);
  const huge = plan.batches.find((x) => x.files[0].path.endsWith('huge.md'));
  assert.equal(huge.files.length, 1);
  assert.equal(huge.truncated, true);

  // 4. Batching on bytes beat batching on count by a wide margin, and the pack
  //    is close to the information-theoretic floor. The floor has to be
  //    computed on the packable bytes only: the 8.4 MB transcript occupies one
  //    batch while accounting for eleven budgets' worth, so including it in the
  //    divisor would ask for a batch count no honest packer can reach and would
  //    fail a correct implementation.
  const packable = plan.batches.filter((x) => !x.truncated).reduce((s, x) => s + x.bytes, 0);
  const floor = Math.ceil(packable / DEFAULT_BUDGET_BYTES) + plan.oversized;
  assert.ok(
    plan.batches.length >= floor,
    `${plan.batches.length} batches is below the ${floor} even a perfect packer needs`,
  );
  assert.ok(
    plan.batches.length <= floor + 3,
    `${plan.batches.length} batches is wasteful against a floor of ${floor}`,
  );

  // 5. Non-oversized batches are actually full. A packer that opens a new batch
  //    whenever a file does not fit the LAST batch, without refilling earlier
  //    holes, still passes the budget invariant above and still roughly triples
  //    the subagent count — which is the cost this module exists to avoid.
  const meanFill = packable / (nonTruncated.length * DEFAULT_BUDGET_BYTES);
  assert.ok(meanFill > 0.8, `mean fill is only ${(meanFill * 100).toFixed(1)}% of budget`);
});

test('a two-thousand file worklist produces a plan that scales by bytes, not by count', () => {
  // The shape behind the plan's quoted figure: 1,821 unindexed files, 334
  // batches. Reproduced here with a counted file budget rather than a magic
  // number, because the corpus grows between runs and the property is the one
  // that matters — batch count tracks total bytes over budget, so adding
  // another thousand 3 KB notes cannot silently double the number of subagents.
  const files = [];
  files.push(f('huge.md', 8.4 * 1024 * 1024));
  for (let i = 0; i < 20; i += 1) files.push(f(`mid-${i}.md`, 200 * KB));
  for (let i = 0; i < 2000; i += 1) files.push(f(`small-${i}.md`, 3 * KB));

  const plan = planBatches(files, {});
  assert.equal(plan.files, 2021);
  assert.equal(plan.oversized, 1);

  // 6.1 MB of non-oversized content at 800 KB is a floor of 8 batches. A
  // count-based rule would have made ~400 batches of 5 files.
  const floor = Math.ceil((plan.totalBytes - 8.4 * 1024 * 1024) / DEFAULT_BUDGET_BYTES);
  assert.ok(plan.batches.length >= floor);
  assert.ok(plan.batches.length <= floor + 4, `${plan.batches.length} batches vs a floor of ${floor}`);
  assert.ok(plan.batches.length < 30, `${plan.batches.length} batches is not byte packing`);
});