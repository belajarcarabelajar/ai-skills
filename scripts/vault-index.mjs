// scripts/vault-index.mjs
//
// Works out which notes in the Obsidian vault have never been through
// extraction, so that the rebuild can fan subagents out over the difference
// instead of over the whole corpus.
//
// The single decision this module refuses to make for itself is WHICH FILES
// COUNT. The vault's `.graphifyignore` excludes `Satset/`, a directory of
// several hundred files of secret material, and that exclusion is a deliberate
// privacy boundary set by a person who understood what is in there. So
// eligibility is not decided here. It is delegated to graphify's own detector,
// which is the only implementation of these rules that has been exercised
// against that boundary. Writing a gitignore matcher here would be a second
// implementation of a security control, and the failure mode of the second one
// is not a stack trace — it is a clean-looking worklist containing one filename
// that should never have left the machine. Every line of that argument is
// worth more than the ten lines of matching code it replaces.
//
// The second reason to delegate rather than reimplement: graphify's rules are
// not the ones you would guess. Measured against the real vault on 2026-10-02,
// `detect()` applied 8 ignore patterns, pruned a `Legacy/` subtree, and also
// picked up two `AGENTS.md.bak-*` files. A hand-rolled matcher that reproduced
// the obvious part of the syntax would still miss all of that.
//
// Three properties of the wrapper are load-bearing, and each exists because the
// alternative reads as success:
//
//   1. THE ROOT IS A Path, NOT A STRING. `detect()` opens with `root.resolve()`,
//      which str does not have. Passing a string dies with an AttributeError
//      (measured, not assumed). PYTHON_SNIPPET is exported so that this is
//      checkable by reading the snippet rather than by trusting this comment.
//
//   2. A MISSING ROOT THROWS. `detect()` on a non-existent directory does NOT
//      raise: it warns on stderr, returns `total_files: 0`, and exits 0
//      (measured). Forwarded faithfully, that is a worklist of zero files,
//      which is indistinguishable from "the vault is fully indexed" — the one
//      report this module exists to produce and the one report nobody can act
//      on. So the existence check happens in JavaScript, before the boundary is
//      crossed, and a non-zero exit is raised with its stderr attached rather
//      than being parsed optimistically.
//
//   3. A PYTHON FAILURE IS NAMED. Any error from the subprocess becomes a
//      `vault-index:` error carrying `.stderr` and `.exitCode`. An empty
//      eligible list is a legitimate answer — a repo whose notes are all
//      ignored really does have none — so it must be distinguishable from a
//      detector that crashed, and only the exit code tells them apart.
//
// Paths are relativised against the resolved root on the way out, always, and a
// path that cannot be relativised raises rather than being returned as-is. An
// absolute path escaping this module would end up as a worklist entry naming
// `/home/<user>/...`, which is both machine-specific (so the worklist does not
// reproduce) and a mild disclosure of the directory layout. The manifest is
// already repo-relative by construction — graphify writes it that way when
// given a root (#777) — so the two sides of the subtraction agree by design
// rather than by luck.
//
// Sorting is unconditional. This output is the input to a fan-out across
// parallel subagents; an unsorted list makes the same work look different on
// every run, and a diff of two worklists is the cheapest possible check that
// the rebuild is not going sideways.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * graphify's installed site-packages, injected onto `sys.path` rather than
 * depended on the ambient interpreter. The interpreter is a plain `python3` —
 * a dedicated virtualenv would pin this module to one uv tool install, and the
 * only thing being imported is a pure-python detector that needs nothing the
 * system interpreter lacks.
 */
export const GRAPHIFY_SITE_PACKAGES =
  '/home/belajarcarabelajar/.local/share/uv/tools/graphifyy/lib/python3.14/site-packages';

/**
 * Buckets consulted from `detect()`. `document` and `paper` are the two that
 * hold prose; `code`, `image` and `video` are not notes and indexing them
 * would spend subagent budget on a Python file and a screenshot.
 */
export const DEFAULT_BUCKETS = Object.freeze(['document', 'paper']);

/**
 * Extensions kept within those buckets, lowercase and dot-prefixed.
 *
 * `detect()` buckets by a broader rule than "a note" — its document class also
 * takes `.txt`, `.rst`, `.html`, `.yaml` and `.yml` — so this narrows the class
 * to the formats worth an extraction pass. The narrowing is counted rather than
 * silent: a file dropped here is a file someone might have wanted, and
 * `counts.droppedByExtension` is how that gets noticed.
 */
export const DEFAULT_EXTENSIONS = Object.freeze(['.md', '.mdx', '.pdf']);

/** Where graphify records what it has already seen. Relative to the root. */
export const MANIFEST_RELPATH = 'graphify-out/manifest.json';

/**
 * The python program this module runs, as a single string.
 *
 * Exported, and asserted against in the test file, for one reason: the only
 * thing standing between this module and a code-injection bug is that the root
 * arrives as an argv value and is never interpolated into this source. Both
 * the site-packages directory and the root are positional arguments, so a path
 * containing a quote, a newline or a backslash is data and stays data.
 *
 * The JSON is tagged with a sentinel because `detect()` writes its own
 * diagnostics, and a parse that assumed "stdout is my JSON" would break the
 * first time graphify printed a notice. Anything before the sentinel is
 * discarded; anything after it is parsed.
 */
export const PYTHON_SNIPPET = `
import json, sys
sys.path.insert(0, sys.argv[2])
from pathlib import Path
from graphify import detect
result = detect.detect(Path(sys.argv[1]))
out = {
    "files": result["files"],
    "total_files": result["total_files"],
    "total_words": result["total_words"],
    "ignored": result["ignored"],
    "unclassified": result["unclassified"],
    "walk_errors": result["walk_errors"],
    "graphifyignore_patterns": result["graphifyignore_patterns"],
    "scan_root": result["scan_root"],
}
sys.stdout.write("\\n__VAULT_INDEX_JSON__" + json.dumps(out))
`;

/** Marks the start of the payload in the subprocess's stdout. */
const SENTINEL = '__VAULT_INDEX_JSON__';

/** Every error this module raises carries this prefix, so callers can match on it. */
const ERROR_PREFIX = 'vault-index:';

/** Raised for a missing root, a bad interpreter, or a failed detector run. */
export class VaultIndexError extends Error {
  constructor(message, { cause, stderr, exitCode } = {}) {
    super(`${ERROR_PREFIX} ${message}`, { cause });
    this.name = 'VaultIndexError';
    this.code = 'vault-index-error';
    if (stderr !== undefined) this.stderr = stderr;
    if (exitCode !== undefined) this.exitCode = exitCode;
  }
}

/** Lowercase, dot-prefixed extension, or `''` when there is none. */
function extnameOf(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/**
 * Make one absolute path repo-relative against `root`, or refuse.
 *
 * The refusal is the point. A path outside the root, or one that is already
 * relative, means the two sides of the subtraction are being compared in
 * different coordinate systems — and the resulting worklist would be either
 * silently short or silently full of junk. Both are worse than an error, so the
 * check happens at the boundary where the origin is still known.
 */
function relativise(absPath, root) {
  if (!isAbsolute(absPath)) {
    throw new VaultIndexError(`expected an absolute path from the detector, got ${JSON.stringify(absPath)}`);
  }
  const rel = relative(root, absPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new VaultIndexError(`detector returned a path outside the root: ${absPath}`);
  }
  return rel.split(sep).join('/');
}

/**
 * Normalise a manifest key to the same repo-relative, forward-slash shape the
 * eligible list uses.
 *
 * graphify already writes relative keys when it is given a root, and its
 * out-of-root fallback writes an absolute one. Absolute keys are kept as
 * absolute here rather than being mangled: they can never match an eligible
 * path, which makes them inert, and turning one into a relative path would
 * invent a file that does not exist.
 */
function normaliseManifestKey(key) {
  if (typeof key !== 'string' || key === '') return null;
  if (isAbsolute(key) || /^[A-Za-z]:/.test(key)) return key.split(sep).join('/');
  return key.split(sep).join('/').replace(/^\.\//, '');
}

/**
 * Resolve and validate a root before it crosses into python.
 *
 * `statSync` rather than `existsSync`, because a path that exists but is a
 * regular file is just as wrong as one that is missing, and the detector
 * treats both the same way: quietly, with zero files.
 */
function resolveRoot(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new VaultIndexError(`root must be a non-empty path string, got ${JSON.stringify(root)}`);
  }
  const abs = resolve(root);
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    throw new VaultIndexError(`no-such-root: ${abs} does not exist`, { cause: err });
  }
  if (!st.isDirectory()) {
    throw new VaultIndexError(`not-a-directory: ${abs} is not a directory`);
  }
  return abs;
}

/**
 * Run the detector and return its parsed payload.
 *
 * `spawnSync` rather than a shell string, so the root is passed as an argv
 * element and is never parsed as syntax. A shell is not needed: there is no
 * pipeline, no redirection and no globbing here, and not having one removes a
 * whole class of quoting bug.
 */
function runDetect(absRoot, opts) {
  const python = opts.python ?? 'python3';
  const sitePackages = opts.sitePackages ?? GRAPHIFY_SITE_PACKAGES;

  const res = spawnSync(python, ['-c', PYTHON_SNIPPET, absRoot, sitePackages], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // A neutral environment: detector behaviour that depends on an ambient
    // variable is a scan that differs between a shell and a test runner, and a
    // worklist that differs between the two is not reproducible.
    env: { ...process.env, GRAPHIFY_GOOGLE_WORKSPACE: '0' },
  });

  if (res.error) {
    throw new VaultIndexError(`could not run ${python}: ${res.error.message}`, { cause: res.error });
  }
  if (res.status !== 0) {
    throw new VaultIndexError(
      `the detector failed with exit code ${res.status}: ${String(res.stderr ?? '').trim() || '(no stderr)'}`,
      { stderr: res.stderr ?? '', exitCode: res.status },
    );
  }

  const at = String(res.stdout ?? '').lastIndexOf(SENTINEL);
  if (at === -1) {
    throw new VaultIndexError(
      `the detector produced no parseable result: ${String(res.stdout ?? '').trim() || '(empty stdout)'}`,
      { stderr: res.stderr ?? '', exitCode: res.status },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(String(res.stdout).slice(at + SENTINEL.length));
  } catch (err) {
    throw new VaultIndexError(`could not parse the detector output as JSON`, { cause: err });
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new VaultIndexError('the detector output was not an object');
  }
  return parsed;
}

/**
 * Eligible note paths, per bucket, as raw internal data.
 *
 * Split out from `listEligible` because `scan` needs the bucket labels to
 * produce its breakdown, and flattening first would throw the labels away.
 */
function detectBuckets(absRoot, opts) {
  const parsed = runDetect(absRoot, opts);

  // `scan_root` is what the detector actually resolved, which can differ from
  // what we resolved if a symlink sits above the root. Relativising against
  // the detector's own idea of the root is the only pairing guaranteed to line
  // up with the absolute paths it returned.
  const scanRoot = isAbsolute(parsed.scan_root ?? '') ? String(parsed.scan_root) : absRoot;
  const buckets = opts.buckets ?? DEFAULT_BUCKETS;
  const exts = new Set((opts.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()));

  const byBucket = {};
  let droppedByExtension = 0;
  for (const bucket of buckets) {
    const list = parsed.files?.[bucket];
    if (!Array.isArray(list)) {
      byBucket[bucket] = [];
      continue;
    }
    const kept = [];
    for (const abs of list) {
      const rel = relativise(abs, scanRoot);
      if (!exts.has(extnameOf(rel))) {
        droppedByExtension += 1;
        continue;
      }
      kept.push(rel);
    }
    byBucket[bucket] = kept.sort();
  }

  return {
    byBucket,
    droppedByExtension,
    ignored: Array.isArray(parsed.ignored) ? parsed.ignored : [],
    totalFiles: Number.isFinite(parsed.total_files) ? parsed.total_files : null,
    graphifyignorePatterns: Number.isFinite(parsed.graphifyignore_patterns)
      ? parsed.graphifyignore_patterns
      : null,
    unclassified: Array.isArray(parsed.unclassified) ? parsed.unclassified.length : null,
    walkErrors: Array.isArray(parsed.walk_errors) ? parsed.walk_errors.length : null,
  };
}

/**
 * Every eligible note in `root`, as sorted repo-relative paths.
 *
 * @param {string} root
 * @param {{python?: string, sitePackages?: string, buckets?: readonly string[],
 *   extensions?: readonly string[]}} [opts]
 * @returns {string[]}
 */
export function listEligible(root, opts = {}) {
  const absRoot = resolveRoot(root);
  const { byBucket } = detectBuckets(absRoot, opts);
  return [...Object.values(byBucket).flat()].sort();
}

/**
 * The repo-relative paths graphify has already recorded in its manifest.
 *
 * A missing manifest is an empty set, not an error: a repository that has never
 * been indexed is the normal first run, and it is exactly the case where the
 * caller most needs a full worklist. A manifest that exists but cannot be
 * parsed IS an error, because "indexed nothing" and "indexed everything" are
 * opposite instructions and a corrupt file must not silently become the first.
 *
 * @param {string} root
 * @returns {Set<string>}
 */
export function readManifest(root) {
  const absRoot = resolveRoot(root);
  const manifestPath = join(absRoot, ...MANIFEST_RELPATH.split('/'));

  let text;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Set();
    throw new VaultIndexError(`could not read ${MANIFEST_RELPATH}: ${err.message}`, { cause: err });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new VaultIndexError(`${MANIFEST_RELPATH} is not valid JSON: ${err.message}`, { cause: err });
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new VaultIndexError(`${MANIFEST_RELPATH} must be a JSON object of path -> row`);
  }

  const keys = new Set();
  for (const key of Object.keys(data)) {
    const norm = normaliseManifestKey(key);
    if (norm) keys.add(norm);
  }
  return keys;
}

/**
 * The full picture: what is eligible, what is already indexed, what is left.
 *
 * `indexed` is the intersection, not the manifest, because a manifest key that
 * is no longer eligible (deleted, or newly ignored) must not shrink the
 * worklist by making the arithmetic look complete. Reporting the intersection
 * keeps `eligible === indexed + worklist` true by construction, and a test
 * asserts exactly that identity.
 *
 * @param {string} root
 * @param {object} [opts] forwarded to `listEligible`
 * @returns {{eligible: string[], indexed: string[], worklist: string[],
 *   counts: object}}
 */
export function scan(root, opts = {}) {
  const absRoot = resolveRoot(root);
  const { byBucket, droppedByExtension, ignored, totalFiles, graphifyignorePatterns, unclassified, walkErrors } =
    detectBuckets(absRoot, opts);

  const eligible = [...Object.values(byBucket).flat()].sort();
  const manifest = readManifest(absRoot);

  const indexed = eligible.filter((p) => manifest.has(p));
  const indexedSet = new Set(indexed);
  const worklist = eligible.filter((p) => !indexedSet.has(p));

  // Per-bucket counts of what actually survived the extension filter, so the
  // breakdown and the total are the same measurement rather than two.
  const bucketCounts = {};
  for (const [bucket, list] of Object.entries(byBucket)) bucketCounts[bucket] = list.length;

  return {
    eligible,
    indexed,
    worklist,
    counts: {
      eligible: eligible.length,
      indexed: indexed.length,
      worklist: worklist.length,
      byBucket: bucketCounts,
      manifestEntries: manifest.size,
      droppedByExtension,
      ignored: ignored.length,
      graphifyignorePatterns,
      detectTotalFiles: totalFiles,
      unclassified,
      walkErrors,
    },
  };
}
