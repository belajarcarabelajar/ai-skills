// scripts/lib/note-name.mjs
//
// The filename every exported session gets, and the only place in the export
// that turns untrusted text into something handed to `writeFileSync`.
//
//   YYYY-MM-DD - <slugified title> [<session-id>].md
//
// Intent Lock decision D10, human-locked. Two properties carry the weight; the
// formatting is the easy part.
//
// 1. NO PATH ESCAPE. A title is free text from a session log. `../../etc/passwd`
//    or `..\\..\\Windows\\System32` as a title must not survive into the name,
//    because the caller joins this basename onto a destination directory. The
//    slug is therefore an ALLOWLIST — only [a-z0-9] survives `slugify()` — and
//    not a denylist of known-bad characters. A denylist is a list of the ways
//    this was already exploited; the allowlist does not need to have been
//    written down in advance. `/`, `\`, `.`, `:`, NUL and every control character
//    are all excluded by the same rule, which is also why `..` cannot appear: it
//    is stripped as punctuation long before it could become a parent reference.
//
// 2. NO SILENT COLLISION. The session id is always present, is never truncated,
//    and is bracketed. Two sessions with byte-identical titles therefore still
//    get different files, and a re-run of the export overwrites exactly the
//    files it wrote last time. If the slug were the only discriminator, two
//    sessions called "daily standup notes" would silently eat each other.
//
// UTC, not local: `timeCreated` is milliseconds since the epoch, and a session
// created at 23:30 UTC belongs to that UTC day regardless of the exporter's
// timezone. Formatting it locally would move a note to a neighbouring day
// depending on which machine ran the export — the same session exported twice
// from two timezones would get two different names. `utcDate()` uses getUTC*;
// the test proves it by re-running under UTC+14 and UTC-12.
//
// UNTITLED SESSIONS. 36 of 1009 real sessions have `title === null`, so the
// fallback chain is a normal path, not an error path:
//
//    title -> first user prompt -> the session id alone
//
// Every rung is slugged through the same allowlist, so the second rung is
// exactly as traversal-safe as the first. The last rung cannot be empty because
// the id is required: without it there is no name that is both valid and unique.
//
// LENGTH. The cap is 255 bytes, the ext4/APFS/NTFS filename ceiling. It is
// applied to the SLUG only. Truncating the id would break property 2 for exactly
// the sessions whose titles are longest, which is backwards. The slug is ASCII
// by construction, so bytes === characters and the arithmetic is exact.
//
// This module returns a BASENAME. It never returns a path and never imports
// `node:path`: joining onto the destination directory is the caller's job, and
// keeping the join out of here is what keeps the traversal test meaningful.
//
// Revert: delete this file and scripts/lib/note-name.test.mjs. No other module
// imports it yet.

/** The ext4/APFS/NTFS filename ceiling, in bytes. Also part of the public API. */
export const MAX_BYTES = 255;

// Session ids are `ses_` plus base62. Any string of [A-Za-z0-9_-] is accepted
// verbatim so real ids keep their case and their exact bytes; dots are excluded
// so an id can never spell `..` even in the pass-through branch.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// Everything that is not in this class is a separator. Character classes do not
// need to be enumerated here — a negated class IS the enumeration, exhaustively.
const UNSAFE = /[^a-z0-9]+/g;
const RUNS = /-+/g;
const EDGES = /^-+|-+$/g;
const EDGES_SOFT = /-+$/;

/** Longest first-user-prompt text considered. Past this the slug is noise. */
const PROMPT_LIMIT = 200;

/**
 * Format a millisecond epoch as `YYYY-MM-DD` in UTC.
 *
 * getUTC* on purpose. The alternative reads identically for every session made
 * during office hours and only diverges at the edges, which is the worst way
 * for a filename bug to present.
 */
function utcDate(ms) {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Lowercase, ASCII-fold, hyphenate. Returns '' when nothing survives, which is
 * a real answer for titles like `...!!!` and `../` and is handled by the caller.
 */
function slugify(text) {
  return text
    // NFKD splits accented Latin into base + combining mark; the marks are then
    // not in [a-z0-9] and vanish. 'Café' -> 'cafe', not 'caf'.
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(UNSAFE, '-')
    .replace(RUNS, '-')
    .replace(EDGES, '');
}

/**
 * The id, verbatim when it is already filename-safe, allowlist-reduced when it
 * is not. Real ids take the verbatim branch and keep their exact bytes; the
 * reduced branch exists so a corrupted or hand-written id cannot open a path
 * either.
 */
function safeId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) {
    throw new TypeError(
      'noteName: session.id is required — without it no filename can be unique, '
      + 'and a collision overwrites a real note on the next export',
    );
  }
  return SAFE_ID.test(id) ? id : slugify(id);
}

/** The first user prompt, bounded. Non-strings and blanks yield ''. */
function firstPromptText(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  return trimmed === '' ? '' : trimmed.slice(0, PROMPT_LIMIT);
}

/**
 * Build the filename for one exported session.
 *
 * @param {{ id: string, title?: unknown, timeCreated?: number }} session
 *   `id` is required. `title` may be absent, null, or any non-string at all.
 *   `timeCreated` is a millisecond epoch and is required.
 * @param {{ firstUserText?: unknown }} [opts] the first user prompt, used only
 *   when the title slugifies to nothing.
 * @returns {string} a basename. Never a path, never empty, never over MAX_BYTES.
 * @throws {TypeError} if the id is missing, or the timestamp is not a finite
 *   number. Both are conditions under which no correct name exists.
 */
export function noteName(session, opts = {}) {
  const s = session && typeof session === 'object' ? session : {};

  // Id first, timestamp second. Both are hard requirements, but the id is the
  // one that decides whether a name can exist at all, so a session that is
  // missing both is reported as an un-nameable session rather than as a clock
  // problem.
  const id = safeId(s.id);

  const when = typeof s.timeCreated === 'number' ? s.timeCreated : Number.NaN;
  if (!Number.isFinite(when)) {
    throw new TypeError(
      'noteName: session.timeCreated is required and must be a finite '
      + 'millisecond epoch — inventing 1970-01-01 would misfile every note',
    );
  }
  const firstText = firstPromptText(opts && typeof opts === 'object' ? opts.firstUserText : undefined);

  // The fallback chain, each rung slugged by the same allowlist so no rung can
  // be less safe than the first. The id is the last resort and is already safe.
  let slug = slugify(typeof s.title === 'string' ? s.title : '');
  if (slug === '') slug = slugify(firstText);
  if (slug === '') slug = id;

  // Everything except the slug is fixed, so the budget is exact. One byte under
  // MAX_BYTES, and ASCII means bytes === characters.
  const prefix = `${utcDate(when)} - `;
  const suffix = ` [${id}].md`;
  const budget = MAX_BYTES - 1 - prefix.length - suffix.length;
  if (budget < 1) {
    throw new RangeError(
      `noteName: session id is ${id.length} characters, leaving no room for a slug `
      + `within the ${MAX_BYTES}-byte filename limit`,
    );
  }
  if (slug.length > budget) slug = slug.slice(0, budget).replace(EDGES_SOFT, '');

  return `${prefix}${slug}${suffix}`;
}