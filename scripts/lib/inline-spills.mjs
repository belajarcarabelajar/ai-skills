// scripts/lib/inline-spills.mjs
//
// Inline a truncated OpenCode tool output so an exported note is self-contained.
//
// WHEN THIS MATTERS. A tool that returns more output than fits inline is
// TRUNCATED, and the full text is written to a sibling file. The tool part's
// JSON keeps a pointer at `state.metadata.outputPath` next to `truncated` and
// `contentType`, plus the truncated head in `state.content[]`. Measured on this
// machine: 81 such files, 42 KB to 1.0 MB, named `tool_<id>`, under
// ~/.local/share/opencode/tool-output.
//
// A note that cites that path is not self-contained. It is a pointer into
// somebody's home directory, from a session log, to a file that gets rotated
// out of existence — one pointer in the live database today already names a
// file that is gone. So the export pastes the bytes instead.
//
// WHY THIS IS A SECURITY MODULE AND NOT A STRING CONCATENATION. The pointer
// is data, recovered from a session log, and it is an ABSOLUTE path. An
// inliner that obeys it hands any writer of a session log a way to name a file
// the exporter will read and paste into a vault note: `/etc/passwd`, `~/.ssh/
// id_ed25519`, `~/cloudflare/.env`. That is the file in this repository's own
// AGENTS.md whose token must never be printed. So:
//
//   * every read is confined to `opts.allowedRoot`, checked on the RESOLVED
//     path, so `..` and absolute-elsewhere pointers cannot escape;
//   * the containment check runs a SECOND time on the REALPATH, because a
//     symlink sitting inside the root is a pointer whose text is in bounds and
//     whose target is not — a bypass that survives any string check;
//   * an out-of-root pointer is REFUSED BEFORE the read, never read-then-
//     inspected. The refusal branch performs no I/O at all.
//
// WHY THE DEGRADED BRANCHES EXIST. An export must not fail because one
// captured file was rotated away, locked, or turned out to be a PNG. Every
// unreadable path returns a MARKER naming the original pointer rather than
// throwing, and every truncation is announced. A note that silently loses the
// tail of a tool output is worse than one that says it lost the tail, because
// the first reads as complete. If a downstream renderer is matching these, the
// four marker prefixes below are the whole vocabulary — they are exported
// constants, not per-call strings, so the wording cannot drift.

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// The directory OpenCode spills tool output into. Absolute; a relative pointer
// is resolved against the ROOT, never against the cwd, so a note exported from
// a different working directory cannot pick up a different file.
export const DEFAULT_ALLOWED_ROOT = path.join(homedir(), '.local', 'share', 'opencode', 'tool-output');

// Generous on purpose: the largest of the 81 real spills on this machine is
// 1048100 bytes, so a default below ~1 MB would truncate the very files this
// module exists to rescue, for every caller that forgot to pass a bound.
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

// The four markers. Prefixes, not templates — the variable part is appended
// after them, so a renderer can match on the bracketed tag alone.
export const REFUSED_MARKER = '[SPILL REFUSED: outside allowed root]';
export const MISSING_MARKER = '[SPILL MISSING:';
export const BINARY_MARKER = '[SPILL BINARY:';
export const TRUNCATED_MARKER = '[SPILL TRUNCATED:';

// ---------- containment ----------

// True only when `target` is a strict descendant of `root`. String-prefix
// comparison is not enough on its own: `<root>2` has `<root>` as a prefix and
// is a different directory entirely, hence the separator.
export function isInsideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The second check. `path.resolve` collapses `..` in the POINTER, but it
// cannot follow a link, so a symlink planted inside the root would otherwise
// pass the first check and then read out of it. realpath on the root too,
// because the root itself may sit under a symlinked tmpdir (/tmp on some
// systems) and comparing a resolved path against an unresolved one would then
// mismatch for innocent reasons.
function escapesViaLink(root, target) {
  let realRoot;
  let realTarget;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(target);
  } catch {
    // The root or the target does not exist. A pointer to a nonexistent file
    // cannot be a symlink to somewhere else, so there is nothing to resolve
    // and no reason to refuse on link grounds; the caller reports it missing.
    return false;
  }
  return !isInsideRoot(realRoot, realTarget);
}

// ---------- text handling ----------

// Is this buffer valid utf8? Decoding and re-encoding is the honest test: the
// decoder substitutes U+FFFD for anything malformed, and a lossy decode never
// re-encodes to the original bytes. A file with a NUL, or a BOM, or 4-byte
// emoji all pass — this is about ENCODING, not about "looks like text".
function isValidUtf8(buf) {
  return Buffer.compare(Buffer.from(buf.toString('utf8'), 'utf8'), buf) === 0;
}

// Drop a trailing incomplete utf8 sequence so a byte-bound truncation does not
// decode into a replacement char. The buffer is already known to be valid
// utf8, so a complete sequence is always present within the last 4 bytes.
function dropPartialSequence(buf) {
  for (let back = 1; back <= 4 && back <= buf.length; back++) {
    const b = buf[buf.length - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte, keep walking back
    const need = b < 0x80 ? 1 : (b & 0xf8) === 0xf0 ? 4 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xc0) === 0xc0 ? 2 : 1;
    // `back` is how many bytes of the sequence are actually present.
    return back >= need ? buf.length : buf.length - back;
  }
  return buf.length;
}

// The truncated head, for the no-pointer branch. OpenCode writes an array of
// `{type:'text', text}` parts; a bare string and an array of plain strings are
// both tolerated because the shape is a session-log detail, not a contract.
function inlineContent(state) {
  const c = state.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter((t) => t !== '')
    .join('\n');
}

// A usable positive bound, or the default. `maxBytes: 0` is honoured (it
// truncates everything, which is a legitimate ask); undefined, NaN, negative
// and junk fall back rather than throwing.
function resolveMaxBytes(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return DEFAULT_MAX_BYTES;
}

// The single place the bound is applied, to whichever text is about to be
// returned, so the no-pointer branch cannot be a way around it.
function bound(text, source, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const kept = buf.subarray(0, dropPartialSequence(buf.subarray(0, maxBytes))).toString('utf8');
  return (
    kept +
    `\n${TRUNCATED_MARKER} ${source} — showing at most ${maxBytes} of ${buf.length} bytes; ` +
    `the full tool output is NOT inlined in this note]\n`
  );
}

// ---------- the inliner ----------

/**
 * Return the full text of a tool result, inlining the spill when one exists.
 *
 * @param {unknown} state  an OpenCode tool part's `state` (status/content/metadata)
 * @param {object} [opts]
 * @param {string} [opts.allowedRoot]  directory reads are confined to
 *   (default DEFAULT_ALLOWED_ROOT)
 * @param {number} [opts.maxBytes]  hard cap on the returned text
 *   (default DEFAULT_MAX_BYTES, inclusive)
 * @param {(p: string) => Buffer} [opts.readFile]  read seam, defaults to
 *   `readFileSync`; injectable so a test can assert on what was opened
 * @returns {string} never throws; every failure becomes a marker naming the
 *   original pointer
 */
export function inlineSpill(state, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};

  // A tool part that is not a tool part. `Array.isArray` is excluded on
  // purpose: an array has no metadata and no content worth inlining, and
  // returning `[]` verbatim would hand the renderer something that is not text.
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return bound(typeof state === 'string' ? state : '', '[no tool state]', resolveMaxBytes(o.maxBytes));
  }

  const maxBytes = resolveMaxBytes(o.maxBytes);
  const metadata = state.metadata && typeof state.metadata === 'object' ? state.metadata : {};
  const pointer = metadata.outputPath;

  // No usable pointer: the inline content is the answer, already truncated by
  // OpenCode. Nothing here touches the filesystem.
  if (typeof pointer !== 'string' || pointer.trim() === '') {
    return bound(inlineContent(state), '[inline, no spill pointer]', maxBytes);
  }

  const readFile = typeof o.readFile === 'function' ? o.readFile : readFileSync;
  const root = path.resolve(
    typeof o.allowedRoot === 'string' && o.allowedRoot !== '' ? o.allowedRoot : DEFAULT_ALLOWED_ROOT,
  );
  const target = path.resolve(root, pointer);

  // REFUSAL FIRST, NO I/O. This branch deliberately performs no read, so a
  // refusal is provable from the call log and not merely inferred from the
  // output text.
  if (!isInsideRoot(root, target) || escapesViaLink(root, target)) {
    return `${REFUSED_MARKER} ${pointer}\n(not read; allowed root is ${root})`;
  }

  let buf;
  try {
    buf = readFile(target);
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf), 'utf8');
  } catch (err) {
    // Gone, locked, or a directory. The pointer is named either way: a reader
    // of the note needs to know WHICH file is not there, and the reason
    // separates "never existed" from "exists and we were refused".
    const reason = err && err.code ? ` (${err.code})` : '';
    return `${MISSING_MARKER} ${pointer}${reason}]\n`;
  }

  if (!isValidUtf8(buf)) {
    return (
      `${BINARY_MARKER} ${pointer} — ${buf.length} bytes are not valid utf8; not inlined]\n` +
      '(binary tool output cannot be rendered as note text)'
    );
  }

  return bound(buf.toString('utf8'), pointer, maxBytes);
}

/**
 * Wrap already-inlined text in a fence long enough to contain it.
 *
 * Spilled output is captured text, and captured text contains fences — a
 * markdown sample, a shell here-doc. Dropped into a ``` block, the body's own
 * fence closes the block early and the rest of the note renders as prose. The
 * fence is therefore sized to the longest backtick run in the body, which
 * leaves the text itself byte-for-byte intact.
 *
 * @param {unknown} text
 * @param {{info?: string}} [opts]  `info` is the language tag
 * @returns {string}
 */
export function fenceInline(text, opts) {
  const body = typeof text === 'string' ? text : '';
  const info = opts && typeof opts.info === 'string' && opts.info !== '' ? opts.info : 'text';
  let fence = '```';
  for (const m of body.matchAll(/`+/g)) {
    if (m[0].length >= fence.length) fence = '`'.repeat(m[0].length + 1);
  }
  return `${fence}${info}\n${body}${body.endsWith('\n') ? '' : '\n'}${fence}\n`;
}
