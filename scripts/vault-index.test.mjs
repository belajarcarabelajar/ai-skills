// scripts/vault-index.test.mjs
//
// Guards for the worklist arithmetic that decides which of the vault's notes
// still need extraction, and — more to the point — for the boundary that
// decides which notes are ALLOWED to be looked at.
//
// That boundary is the reason this module exists in the shape it does. The
// vault's `.graphifyignore` excludes `Satset/`, which holds hundreds of files
// of secret material, and the way this module finds out what is eligible is by
// asking graphify's own detector rather than by walking the tree with a
// hand-written gitignore matcher. A second implementation of a privacy
// boundary is a second thing that can be wrong, and its failure mode is the
// worst kind available: not an error, not a partial result, but a plausible
// list of files to send to a subagent, one of which should never have been
// named. Every test below that asserts an exclusion is really asserting that
// we did not reimplement the exclusion.
//
// The second property is that a quiet wrong answer is worse than a loud one.
// `detect()` on a directory that does not exist does not raise — measured, not
// assumed: it prints a warning to stderr, returns `total_files: 0`, and exits
// 0. A wrapper that forwarded that faithfully would report an empty worklist
// and read as "everything is already indexed". So the non-existent-root test
// below is not pedantry; it pins the specific behaviour that would otherwise be
// indistinguishable from success.
//
// Fixtures are synthetic and built in a temp directory, on purpose. A test that
// asserts against the real vault passes on this machine and fails on the next
// one, and a test that fails on another machine teaches the next person to
// delete it. The one live test at the bottom is the deliberate exception: it
// skips when the vault is absent, and when it does run it asserts the real
// counts so that drift in the vault is visible rather than silent.
//
// The fixture's own ignore files are named distinctively (`secret-drop/`,
// `git-drop/`) so that a test failure says which boundary broke instead of
// merely saying a number is wrong.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, sep } from 'node:path';

import {
  GRAPHIFY_SITE_PACKAGES,
  DEFAULT_BUCKETS,
  DEFAULT_EXTENSIONS,
  listEligible,
  readManifest,
  scan,
  PYTHON_SNIPPET,
} from './vault-index.mjs';

// ---------- per-test timeout ----------
//
// Almost every test below crosses a process boundary: it spawns `python3`,
// which imports the whole `graphify` package and walks a directory tree. On an
// idle machine one spawn costs a few hundred milliseconds and the suite passes
// on node:test's 5 s default. That default is the problem, and it was found by
// running the suite while three other agent chunks were saturating the CPU —
// the suite went red on a test that is green in isolation. A test whose verdict
// depends on machine load is not a test of the module.
//
// So the ceiling is raised here, once, for every test in the file rather than
// per-test, because picking which tests "deserve" a longer budget is a judgement
// that rots the moment someone adds a test. A ceiling is not a delay: the
// readManifest tests below still finish in milliseconds. The two `live` tests
// pass their own, larger, budget and are unaffected.
const SPAWN_TIMEOUT_MS = 60_000;

/** `test` with a ceiling that survives a loaded machine. */
function spawning(name, fn) {
  test(name, { timeout: SPAWN_TIMEOUT_MS }, fn);
}

// ---------- fixture ----------

// Retained so the temp trees can be removed on the way out. Every test builds
// its own: a shared fixture that one test mutates turns an ordering dependency
// into a mystery, and `bun test` does not guarantee file order within a file.
const madeDirs = [];

after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A miniature repo with all three exclusion mechanisms in play at once.
 *
 * `.graphifyignore` and `.gitignore` each drop a differently-named directory, so
 * a failure to honour either one is attributable. The `.md` bodies are a few
 * words long because `detect()` word-counts every text file it walks, and a
 * fixture of real notes would make this slow for no added coverage.
 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'vault-index-fixture-'));
  madeDirs.push(root);

  const files = {
    'notes/alpha.md': '# alpha\n\nfirst note body.\n',
    'notes/beta.md': '# beta\n\nsecond note body.\n',
    'sub/deep.md': '# deep\n\nthird note body.\n',
    'secret-drop/hidden.md': '# hidden\n\nshould never be listed.\n',
    'git-drop/ignored.md': '# ignored\n\nshould never be listed either.\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }

  writeFileSync(join(root, '.graphifyignore'), 'secret-drop/\n');
  writeFileSync(join(root, '.gitignore'), 'git-drop/\n');
  return root;
}

/** A fixture plus a manifest naming one of its notes as already indexed. */
function makeFixtureWithManifest() {
  const root = makeFixture();
  mkdirSync(join(root, 'graphify-out'), { recursive: true });
  // Shaped like the real manifest: a flat map of repo-relative path -> row.
  writeFileSync(
    join(root, 'graphify-out', 'manifest.json'),
    JSON.stringify({ 'notes/alpha.md': { mtime: 1, seen: 2, ast_hash: 'x', semantic_hash: 'x' } }, null, 2),
  );
  return root;
}

// ---------- listEligible ----------

spawning('a plain .md file in the fixture is listed', () => {
  const root = makeFixture();
  const eligible = listEligible(root);

  assert.ok(
    eligible.includes('notes/alpha.md'),
    `expected notes/alpha.md in [${eligible.join(', ')}]`,
  );
});

spawning('a file matched by the fixture .graphifyignore is NOT listed', () => {
  const root = makeFixture();
  const eligible = listEligible(root);

  assert.ok(!eligible.includes('secret-drop/hidden.md'), '.graphifyignore was not honoured');
  assert.ok(
    !eligible.some((p) => p.startsWith('secret-drop/')),
    `secret-drop leaked into [${eligible.join(', ')}]`,
  );
});

spawning('a file matched by the fixture .gitignore is NOT listed', () => {
  const root = makeFixture();
  const eligible = listEligible(root);

  assert.ok(!eligible.includes('git-drop/ignored.md'), '.gitignore was not honoured');
  assert.ok(!eligible.some((p) => p.startsWith('git-drop/')), 'git-drop leaked into the eligible list');
});

spawning('paths come back repo-relative, never absolute', () => {
  const root = makeFixture();
  const eligible = listEligible(root);

  assert.ok(eligible.length > 0, 'fixture produced no eligible files, so this proves nothing');
  for (const p of eligible) {
    assert.ok(!isAbsolute(p), `${JSON.stringify(p)} is absolute`);
    // A Windows-style drive or UNC prefix is absolute too, and `isAbsolute` on
    // POSIX does not know about either.
    assert.ok(!/^[A-Za-z]:/.test(p), `${JSON.stringify(p)} carries a drive letter`);
    assert.ok(!p.startsWith('\\\\'), `${JSON.stringify(p)} is a UNC path`);
    // On a POSIX host the platform separator IS the slash, so this is the
    // check that would actually catch a native-separator leak.
    assert.ok(!p.includes(sep) || sep === '/', `${JSON.stringify(p)} uses a native separator`);
  }
});

spawning('the eligible list is sorted, so two runs diff cleanly', () => {
  const root = makeFixture();
  const first = listEligible(root);
  const second = listEligible(root);

  assert.deepEqual(first, second, 'two scans of one fixture disagreed');
  assert.deepEqual(first, [...first].sort(), 'result is not in sorted order');
});

spawning('a root that does not exist throws a named error rather than returning []', () => {
  const missing = join(tmpdir(), 'vault-index-definitely-absent-9f2a');

  // The specific hazard: detect() does not raise on a missing root. It warns on
  // stderr, returns total_files 0, and exits 0. Forwarding that would make
  // "you pointed me at nothing" look exactly like "there is nothing to do".
  assert.throws(
    () => listEligible(missing),
    (err) => {
      assert.ok(err instanceof Error, 'threw a non-Error');
      assert.match(err.message, /vault-index/);
      assert.match(err.message, /no-such-root/);
      return true;
    },
  );
});

spawning('a root that is a file, not a directory, throws too', () => {
  const root = makeFixture();
  const notADir = join(root, 'notes', 'alpha.md');

  assert.throws(() => listEligible(notADir), /vault-index/);
});

spawning('the python layer is handed a Path, never a str', () => {
  // The failure this guards is measured, not hypothetical: detect() opens with
  // `root.resolve()`, which does not exist on str, so a string root dies with
  // AttributeError. The test asserts the guarantee structurally — the module
  // exports the source of the snippet it sends, and that snippet can only ever
  // construct the argument through Path(...). A regression to `detect.detect(root)`
  // with a bare interpolated string is visible here as a missing Path(...).
  assert.equal(typeof PYTHON_SNIPPET, 'string');
  assert.match(PYTHON_SNIPPET, /Path\(\s*sys\.argv\[1\]\s*\)/);
  assert.match(PYTHON_SNIPPET, /sys\.path\.insert/);
  // And it must not pass the root through some other channel — a literal
  // f-string interpolation of the path into the snippet is the exact bug that
  // makes a path with a quote in it a code injection.
  assert.doesNotMatch(PYTHON_SNIPPET, /detect\(\s*["'{]/);
});

// ---------- readManifest ----------

spawning('readManifest returns repo-relative keys from graphify-out/manifest.json', () => {
  const root = makeFixtureWithManifest();

  const manifest = readManifest(root);
  assert.ok(manifest instanceof Set);
  assert.ok(manifest.has('notes/alpha.md'), 'manifest key missing from the set');
  assert.equal(manifest.size, 1);
});

spawning('a repo with no manifest yields an empty set rather than throwing', () => {
  const root = makeFixture();

  // A first run has nothing indexed yet, which is the normal starting state
  // and not an error. Throwing here would make `scan` unusable on a fresh
  // repo — the one case it is most needed.
  assert.deepEqual([...readManifest(root)], []);
});

spawning('a corrupt manifest throws, because silently indexing nothing loses work', () => {
  const root = makeFixture();
  mkdirSync(join(root, 'graphify-out'), { recursive: true });
  writeFileSync(join(root, 'graphify-out', 'manifest.json'), '{ this is not json');

  assert.throws(() => readManifest(root), /vault-index/);
});

// ---------- scan ----------

spawning('scan splits the fixture into eligible, indexed and worklist', () => {
  const root = makeFixtureWithManifest();
  const { eligible, indexed, worklist, counts } = scan(root);

  assert.ok(eligible.includes('notes/alpha.md'));
  // alpha is in the manifest: eligible, and NOT work to do.
  assert.ok(indexed.includes('notes/alpha.md'), 'alpha should be counted as already indexed');
  assert.ok(!worklist.includes('notes/alpha.md'), 'alpha is already indexed, so it is not work');
  // beta and deep are not.
  assert.ok(worklist.includes('notes/beta.md'));
  assert.ok(worklist.includes('sub/deep.md'));
  // Excluded files appear in no bucket at all.
  for (const p of [...eligible, ...indexed, ...worklist]) {
    assert.ok(!p.startsWith('secret-drop/') && !p.startsWith('git-drop/'), `${p} escaped an ignore rule`);
  }

  assert.equal(counts.eligible, eligible.length);
  assert.equal(counts.indexed, indexed.length);
  assert.equal(counts.worklist, worklist.length);
  assert.equal(counts.eligible, counts.indexed + counts.worklist);
});

spawning('the worklist is sorted and contains no duplicates', () => {
  const root = makeFixture();
  const { worklist } = scan(root);

  assert.deepEqual(worklist, [...worklist].sort(), 'worklist is not sorted');
  assert.equal(new Set(worklist).size, worklist.length, 'worklist contains duplicates');
});

spawning('worklist is eligible minus indexed, exactly', () => {
  const root = makeFixtureWithManifest();
  const { eligible, indexed, worklist } = scan(root);

  const expected = eligible.filter((p) => !indexed.includes(p));
  assert.deepEqual([...worklist].sort(), [...expected].sort());
});

spawning('scan is deterministic across repeated runs', () => {
  const root = makeFixtureWithManifest();
  const a = scan(root);
  const b = scan(root);

  assert.deepEqual(a.worklist, b.worklist);
  assert.deepEqual(a.eligible, b.eligible);
  assert.deepEqual(a.counts, b.counts);
});

spawning('counts carry a per-bucket breakdown', () => {
  const root = makeFixture();
  const { counts } = scan(root);

  assert.ok(counts.byBucket, 'counts.byBucket is missing');
  for (const bucket of DEFAULT_BUCKETS) {
    assert.equal(typeof counts.byBucket[bucket], 'number', `no count for bucket ${bucket}`);
  }
  const sum = Object.values(counts.byBucket).reduce((a, b) => a + b, 0);
  assert.equal(sum, counts.eligible, 'per-bucket counts do not add up to the eligible total');
});

spawning('the module does not silently lose files that detect() reports but we do not want', () => {
  // A .txt is eligible to graphify but is neither markdown nor a pdf. It must
  // be excluded deliberately, and the count must say so — a filter that quietly
  // drops files is indistinguishable from a filter that misses them.
  const root = makeFixture();
  writeFileSync(join(root, 'notes', 'plain.txt'), 'not markdown\n');

  const { eligible, counts } = scan(root);

  assert.ok(!eligible.includes('notes/plain.txt'), 'a .txt should not be in a markdown worklist');
  assert.equal(counts.droppedByExtension, 1, 'the dropped file was not accounted for');
});

spawning('a python failure surfaces as a named error carrying stderr', () => {
  // Pointed at a path that exists but whose parent chain makes the snippet
  // itself fail, the module must not swallow the reason. A silent empty result
  // here would read as "nothing to index", which is the exact failure this
  // module exists to prevent.
  const root = makeFixture();
  const { PATH: savedPath } = process.env;
  try {
    // A site-packages that does not exist makes the import fail, and the import
    // is the first thing the snippet does.
    const original = GRAPHIFY_SITE_PACKAGES;
    assert.ok(existsSync(original), 'the real graphify site-packages should exist on this machine');
    // Exercise the error path without mutating the exported constant: use a
    // fixture root plus an override that points at a missing interpreter path.
    assert.throws(
      () => listEligible(root, { sitePackages: join(tmpdir(), 'no-such-site-packages-4b1c') }),
      (err) => {
        assert.match(err.message, /vault-index/);
        assert.ok(err.stderr !== undefined, 'the error should carry stderr for diagnosis');
        return true;
      },
    );
  } finally {
    process.env.PATH = savedPath;
  }
});

spawning('the python binary can be overridden, so a missing interpreter is nameable', () => {
  const root = makeFixture();

  assert.throws(
    () => listEligible(root, { python: join(tmpdir(), 'no-such-python-7d3e') }),
    (err) => {
      assert.match(err.message, /vault-index/);
      return true;
    },
  );
});

// ---------- live vault (skipped when absent) ----------

const VAULT = '/home/belajarcarabelajar/Dokumen/Obsidian Vault';
const live = existsSync(VAULT) ? test : test.skip;

live('the real vault reports the numbers measured on 2026-10-02', { timeout: 300_000 }, () => {
  // Asserted as a band, not an exact figure, and deliberately so. The exact
  // numbers drift every time a note is added, and a test that goes red on an
  // ordinary edit trains people to ignore it. The invariants below are the ones
  // that would indicate a real problem: a worklist that is a small fraction of
  // the corpus, and a boundary that is still excluding the secrets directory.
  const { eligible, worklist, counts } = scan(VAULT);

  assert.ok(eligible.length > 2000, `expected >2000 eligible files, got ${eligible.length}`);
  assert.ok(worklist.length > 1000, `expected >1000 unindexed files, got ${worklist.length}`);
  assert.ok(
    counts.indexed > 400 && counts.indexed < 1000,
    `indexed count ${counts.indexed} is outside the plausible band`,
  );
  assert.equal(counts.eligible, counts.indexed + counts.worklist);

  // The boundary check that matters, against the real thing.
  assert.ok(
    !eligible.some((p) => p.startsWith('Satset/')),
    'Satset/ is excluded by .graphifyignore and must never appear in the worklist',
  );
  assert.ok(counts.ignored > 0, 'detect() reported no ignored paths, so the ignore files were not read');
});

live('the real vault scan is deterministic', { timeout: 300_000 }, () => {
  const a = scan(VAULT);
  const b = scan(VAULT);

  assert.deepEqual(a.worklist, b.worklist);
  assert.deepEqual(a.counts, b.counts);
});

// resolve() is imported for the fixture assertions above; referencing it here
// keeps the import honest if the file is ever trimmed.
assert.equal(typeof resolve, 'function');
