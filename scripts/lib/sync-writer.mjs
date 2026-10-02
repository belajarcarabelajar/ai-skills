// scripts/lib/sync-writer.mjs
//
// The writer for a vault that is a git repository with `obsidian-git` installed.
// That plugin commits and pushes on a 10-minute timer with nobody watching, so
// every file this module touches becomes a file published to a remote. Two
// consequences shape the whole design:
//
//   1. An unchanged note must not be written. Rewriting 1009 identical notes
//      every run makes a 1009-file diff every run, which obsidian-git then
//      pushes. The cost is not the CPU, it is that a genuine 1-line edit gets
//      buried under 1008 no-op entries in a commit, and the user's history fills
//      up with nothing. So `syncWrite` compares exact bytes and, on a match,
//      returns without opening the file for writing at all. Not "writes the same
//      content" — does not touch it. The mtime is left alone, because mtime is
//      what git status looks at, and a bumped mtime is a dirty file no matter
//      what the bytes say.
//
//   2. `relPath` is derived from a note title, and titles are user text. A title
//      of `../../../.bashrc` is a write outside the vault, into a file that is
//      probably under git and very likely pushed. So every path is resolved and
//      proven to sit inside `root` before anything is opened, and an absolute
//      path is refused even when it points inside the root: the contract is
//      "relative to root", and silently accepting the other form is how a caller
//      bug becomes a write to the wrong vault.
//
// Comparison is on bytes, not on strings. `===` on the decoded content would
// call a file "unchanged" when it is not, and the file that gets silently
// skipped is the one carrying the user's edit. CRLF, a trailing newline, a NUL
// byte and a lone surrogate are all differences git can see and this module
// must too.
//
// There is no clock in here and no run counter: given the same tree, the answer
// depends only on the bytes on disk.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const UTF8 = 'utf8';

/**
 * @typedef {'created' | 'written' | 'unchanged'} SyncWriteResult
 *   `created`  — the file did not exist; it and its parents now do.
 *   `written`  — the file existed and its bytes differed; the new bytes are on
 *                disk. Truncating write, so a shorter replacement cannot leave
 *                the tail of the old one behind.
 *   `unchanged`— the bytes were identical; the file was not opened for writing
 *                and its mtime is exactly what it was.
 */

/**
 * Resolve `relPath` under `root`, or throw. This is the security boundary; every
 * exported function goes through it before touching the filesystem.
 *
 * @param {string} root   Absolute or relative vault root.
 * @param {string} relPath Relative path, slash-separated, from a title slug.
 * @returns {string} The absolute path, proven to be strictly below `root`.
 * @throws {Error & { code: 'ERR_PATH_ESCAPE' }} If the path is not relative, is
 *   empty, has a `..` path segment, or resolves outside `root`.
 *
 * KNOWN LIMIT, stated rather than glossed: this is a lexical check, so a symlink
 * already sitting inside the vault is still followed. Resolving symlinks would
 * need a realpath comparison, which on macOS (where `os.tmpdir()` is a symlink)
 * rejects every legitimate path unless both sides are realpath'd, and the vault
 * has no symlinked note directories today. Worth revisiting if a vault ever
 * grows one; not worth pretending it is handled.
 */
export function resolveInside(root, relPath) {
  if (typeof relPath !== 'string' || relPath === '') {
    throw pathEscape(root, relPath, 'it is not a non-empty string');
  }
  if (relPath.includes('\0')) {
    throw pathEscape(root, relPath, 'it contains a NUL byte');
  }
  // posix covers the vault's real layout; win32 catches a title that arrived
  // with a drive letter or a backslash separator, which is absolute on Windows
  // and would silently be a plain filename here.
  if (path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
    throw pathEscape(root, relPath, 'it is an absolute path; paths must be relative to the vault root');
  }

  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, relPath);

  // Segment-exact, not a substring test. A title like `Wait..what` slugs to a
  // perfectly legal filename, and refusing it would drop a real note from the
  // export without a word — silent data loss dressed as a clean run.
  if (relPath.split(/[\\/]/).includes('..')) {
    throw pathEscape(root, relPath, 'it contains a ".." path segment');
  }
  // The containment check, kept even though the `..` rule above is what normally
  // fires. Two reasons: it is the backstop if the segment rule is ever relaxed,
  // and it is what rejects a relPath of `.` — which names the vault directory,
  // not a note in it. Separator-aware, because `${root}-evil` starts with root
  // as a *string* and is a different directory.
  if (!abs.startsWith(resolvedRoot + path.sep)) {
    throw pathEscape(root, relPath, `it resolves to ${abs}, which is outside the vault root ${resolvedRoot}`);
  }
  return abs;
}

function pathEscape(root, relPath, why) {
  const shown = typeof relPath === 'string' ? JSON.stringify(relPath) : String(relPath);
  // Names the rejected input, the root it was refused under, and the rule it
  // broke. A message that only says "invalid path" sends the next reader looking
  // at the caller's code instead of at the title that produced it.
  const err = new Error(
    `refusing to write ${shown}: the path escapes the vault root ${root} (${why}). ` +
      'A note title must slug to a relative path that stays inside the vault.',
  );
  err.code = 'ERR_PATH_ESCAPE';
  return err;
}

/**
 * Read a file's bytes, or null when it is not there.
 * @returns {Buffer|null}
 */
function readBytesIfExists(abs) {
  try {
    return readFileSync(abs);
  } catch (err) {
    // ENOENT: the file is absent. ENOTDIR: a path component above it is a file,
    // so the leaf cannot exist either. Both mean "no such note", and the caller
    // is about to create it.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Read a note under `root`.
 *
 * @param {string} root
 * @param {string} relPath
 * @returns {string|null} UTF-8 content, or null if the file is absent.
 * @throws {Error & { code: 'ERR_PATH_ESCAPE' }} If `relPath` leaves `root`.
 */
export function readIfExists(root, relPath) {
  const abs = resolveInside(root, relPath);
  const bytes = readBytesIfExists(abs);
  return bytes === null ? null : bytes.toString(UTF8);
}

/**
 * Write a note under `root`, writing only when the bytes actually differ.
 *
 * @param {string} root
 * @param {string} relPath
 * @param {string} content
 * @returns {SyncWriteResult}
 * @throws {Error & { code: 'ERR_PATH_ESCAPE' }} If `relPath` leaves `root`.
 */
export function syncWrite(root, relPath, content) {
  const abs = resolveInside(root, relPath);
  if (typeof content !== 'string') {
    throw new TypeError(`content for ${relPath} must be a string, got ${typeof content}`);
  }
  const next = Buffer.from(content, UTF8);

  const existing = readBytesIfExists(abs);
  if (existing === null) {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, next);
    return 'created';
  }
  // Buffer.equals is the whole point: no trimming, no newline normalisation, no
  // encoding round trip. Anything looser reports 'unchanged' for a file the
  // user edited, and that edit is then silently never published.
  if (existing.equals(next)) return 'unchanged';

  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, next);
  return 'written';
}

/**
 * Run a batch of writes and report what happened, for the per-run progress line.
 *
 * Entries are `{ relPath, content }`. The summary is the only thing a caller
 * prints, so it has to be impossible for it to say "3 files" and mean 1009: the
 * invariant `changedPaths.length === created + written` is asserted in the tests
 * rather than trusted here.
 *
 * @param {string} root
 * @param {Array<{ relPath: string, content: string }>} entries
 * @returns {{ created: number, written: number, unchanged: number, total: number, changedPaths: string[] }}
 * @throws {Error & { code: 'ERR_PATH_ESCAPE' }} If any relPath leaves `root`.
 */
export function planWrites(root, entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError(`entries must be an array of { relPath, content }, got ${typeof entries}`);
  }
  const summary = { created: 0, written: 0, unchanged: 0, total: entries.length, changedPaths: [] };
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.relPath !== 'string') {
      throw new TypeError(`every entry needs a string relPath, got ${JSON.stringify(entry)}`);
    }
    const result = syncWrite(root, entry.relPath, entry.content);
    summary[result] += 1;
    // Only the two outcomes that put bytes on disk. Listing an unchanged path
    // here would be the same lie as rewriting it: a diff that looks like work.
    if (result !== 'unchanged') summary.changedPaths.push(entry.relPath);
  }
  return summary;
}
