// scripts/lib/note-name.test.mjs
//
// Guards for the exported-note filename.
//
// `noteName` is the one function every exported session passes through, so the
// two properties worth protecting are not its formatting taste — they are the
// two ways it can destroy somebody's data:
//
//   * PATH ESCAPE. A title is attacker-influenced text that ends up inside a
//     `writeFileSync` call. `../../etc/passwd` as a title must not become a path
//     separator or a parent reference in the result. The implementation is an
//     ALLOWLIST slug (only [a-z0-9] survives), not a denylist, which is why the
//     traversal test can assert a negative instead of enumerating bad inputs.
//   * SILENT COLLISION. Two sessions with the same title must never land on the
//     same file. The session id is always in the name and is never truncated,
//     so the filename is a function of (timeCreated, title, id) and two
//     different ids can never agree. This is the property that lets a re-run of
//     the export overwrite only its own files.
//
// Both are properties of the OUTPUT, so they are asserted against the returned
// string, not against the helper internals. The UTC tests additionally re-run
// `noteName` in a subprocess under two extreme timezones: a single instant
// cannot discriminate east and west of UTC at once, and asserting only against
// the machine's own zone would silently stop proving anything on a machine
// whose zone happens to agree with UTC.
//
// Every fallback for a null title is exercised, because 36 of 1009 real sessions
// have `title === null` (Intent Lock AC-2). The test asserts the fallback chain
// all the way down to the id, and asserts that each rung is still unique.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noteName, MAX_BYTES } from './note-name.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(__dirname, 'note-name.mjs');

// A real-shaped id, verbatim from the session store. The mixed case matters:
// it proves the id is NOT run through the lowercasing slug.
const ID = 'ses_f060a02b6ffeT6dNM5W9HWbyFT';
const ID2 = 'ses_0000000000000000000000aaaa';

// 2026-01-15T09:30:00Z — an ordinary instant, used where the zone is irrelevant.
const WHEN = Date.UTC(2026, 0, 15, 9, 30, 0);

// ---------- 1. the shape ----------

test('a titled session produces the locked filename, and the id keeps its case', () => {
  const name = noteName({ id: ID, title: 'Fix the Firefox audio bug', timeCreated: WHEN }, {});
  assert.equal(name, `2026-01-15 - fix-the-firefox-audio-bug [${ID}].md`);
  assert.ok(name.includes(ID), 'the id must survive verbatim, upper case included');
  assert.ok(!name.includes(' ' + ID.toLowerCase()), 'the slug lowercasing must not have eaten the id');
});

test('the name is a basename: no separator, no drive, no parent reference', () => {
  const name = noteName({ id: ID, title: 'plain title', timeCreated: WHEN }, {});
  assert.equal(path.basename(name), name);
  assert.equal(path.dirname(name), '.');
  assert.ok(!name.includes('/'));
  assert.ok(!name.includes('\\'));
  assert.ok(!name.includes('..'));
});

test('the slug is lowercased, ASCII-safe, and hyphen-joined', () => {
  const name = noteName({ id: ID, title: 'Café Ünïcode — Ø', timeCreated: WHEN }, {});
  assert.equal(name, `2026-01-15 - cafe-unicode [${ID}].md`);
});

test('punctuation runs collapse to single hyphens and never dangle at the edges', () => {
  const name = noteName({ id: ID, title: '  --Wait...  what??  --  ', timeCreated: WHEN }, {});
  assert.equal(name, `2026-01-15 - wait-what [${ID}].md`);
});

// ---------- 2. UTC, proven rather than asserted ----------

test('the date is formatted in UTC, not in the machine zone', () => {
  // 2026-03-05T23:30:00Z. Under WIB (+07:00) the local date is 2026-03-06, so
  // this assertion fails outright if anyone swaps getUTC* for get*Date.
  const ts = Date.UTC(2026, 2, 5, 23, 30, 0);
  const name = noteName({ id: 'ses_tz', title: 'utc probe', timeCreated: ts }, {});
  assert.ok(name.startsWith('2026-03-05 - '), `got ${name}`);
});

// A single instant cannot be a different calendar day from BOTH UTC+14 and
// UTC-12, so the two directions are two subprocesses. Each also reports its own
// local date: if that ever equalled the UTC date, the probe would be proving
// nothing and the assertion below would be a lie rather than a pass.
const ZONE_PROBES = [
  { tz: 'Pacific/Kiritimati', ts: Date.UTC(2026, 2, 5, 23, 30, 0), local: '2026-03-06' },
  { tz: 'Etc/GMT+12', ts: Date.UTC(2026, 2, 5, 11, 0, 0), local: '2026-03-04' },
];

const probe = (p) => {
  const src = `import { noteName } from ${JSON.stringify(MODULE)};
const out = noteName({ id: 'ses_tz', title: 'utc probe', timeCreated: ${p.ts} }, {});
const local = new Date(${p.ts}).toLocaleDateString('en-CA', { timeZone: process.env.TZ });
process.stdout.write(JSON.stringify({ out, local }));`;
  const r = spawnSync('bun', ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, TZ: p.tz },
  });
  assert.equal(r.status, 0, `TZ=${p.tz} stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  return JSON.parse(r.stdout);
};

test('the date stays UTC east of the prime meridian, where the local day differs', () => {
  const p = ZONE_PROBES[0];
  const { out, local } = probe(p);
  assert.equal(local, p.local, `control failed: TZ=${p.tz} did not land on a different local day`);
  assert.ok(out.startsWith('2026-03-05 - '), `TZ=${p.tz} produced ${out}`);
});

test('the date stays UTC west of the prime meridian, where the local day differs', () => {
  const p = ZONE_PROBES[1];
  const { out, local } = probe(p);
  assert.equal(local, p.local, `control failed: TZ=${p.tz} did not land on a different local day`);
  assert.ok(out.startsWith('2026-03-05 - '), `TZ=${p.tz} produced ${out}`);
});

// ---------- 3. the untitled fallback chain (36 of 1009 real sessions) ----------

test('a null title falls back to the slug of the first user prompt', () => {
  const name = noteName(
    { id: ID, title: null, timeCreated: WHEN },
    { firstUserText: 'why is firefox silent on arch' },
  );
  assert.equal(name, `2026-01-15 - why-is-firefox-silent-on-arch [${ID}].md`);
});

test('a first prompt that slugifies to nothing falls through to the next rung', () => {
  // A prompt of pure punctuation is realistic — someone taps Enter on a stray
  // keystroke — and it must not produce an empty title segment.
  const name = noteName({ id: ID, title: null, timeCreated: WHEN }, { firstUserText: '  ...!!!  ' });
  assert.equal(name, `2026-01-15 - ${ID} [${ID}].md`);
});

test('no title and no prompt falls back to the id alone, and is still unique', () => {
  const a = noteName({ id: ID, title: null, timeCreated: WHEN }, {});
  const b = noteName({ id: ID2, title: null, timeCreated: WHEN }, {});
  assert.equal(a, `2026-01-15 - ${ID} [${ID}].md`);
  assert.equal(b, `2026-01-15 - ${ID2} [${ID2}].md`);
  assert.notEqual(a, b);
});

test('an empty or whitespace-only title is treated as untitled, not as a slug', () => {
  for (const title of ['', '   ', '\n\t ']) {
    const name = noteName({ id: ID, title, timeCreated: WHEN }, {});
    assert.ok(name.includes(ID), `title ${JSON.stringify(title)} lost the id`);
    assert.ok(!name.includes(' -  ['), `title ${JSON.stringify(title)} left an empty slug`);
  }
});

// ---------- 4. path traversal ----------

const HOSTILE_TITLES = [
  '../../etc/passwd',
  '..\\..\\Windows\\System32',
  'a/b/c',
  'evil\\..\\..\\escape',
  '..',
  '../',
  '/absolute/path',
  '.',
  'C:\\Windows',
];

test('a hostile title can never produce a separator or a parent reference', () => {
  for (const title of HOSTILE_TITLES) {
    const name = noteName({ id: ID, title, timeCreated: WHEN }, {});
    assert.ok(!name.includes('/'), `${title} -> ${name}`);
    assert.ok(!name.includes('\\'), `${title} -> ${name}`);
    assert.ok(!name.includes('..'), `${title} -> ${name}`);
    assert.ok(!name.includes(':'), `${title} -> ${name}`);
  }
});

test('a hostile title resolves to a file INSIDE the destination directory', () => {
  const dest = mkdtempSync(path.join(tmpdir(), 'note-name-dest-'));
  try {
    const real = path.resolve(dest);
    for (const title of HOSTILE_TITLES) {
      const name = noteName({ id: ID, title, timeCreated: WHEN }, {});
      const resolved = path.resolve(dest, name);
      assert.ok(
        resolved.startsWith(real + path.sep),
        `${title} -> ${name} escaped to ${resolved}`,
      );
      // The strongest statement of the same fact: it is one segment, and it
      // stays one segment even after the OS has had a look at it.
      assert.equal(path.dirname(resolved), real);
    }
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('a hostile first prompt is neutralised on the fallback rung too', () => {
  const name = noteName(
    { id: ID, title: null, timeCreated: WHEN },
    { firstUserText: '../../root/.ssh/id_rsa' },
  );
  assert.ok(!name.includes('/'), name);
  assert.ok(!name.includes('..'), name);
  assert.equal(name, `2026-01-15 - root-ssh-id-rsa [${ID}].md`);
});

test('an id that is not filename-safe is reduced to safe characters, not trusted', () => {
  // Real ids are [A-Za-z0-9_-] and pass verbatim (test 1 proves the case is
  // kept). A hostile or corrupted id must not be able to open a path either.
  const name = noteName({ id: '../../evil', title: 't', timeCreated: WHEN }, {});
  assert.ok(!name.includes('/'), name);
  assert.ok(!name.includes('..'), name);
  assert.ok(name.endsWith('.md'));
});

// ---------- 5. the length cap ----------

test('a 5000-character title stays under 255 bytes and keeps the whole id', () => {
  const name = noteName({ id: ID, title: 'x'.repeat(5000), timeCreated: WHEN }, {});
  assert.ok(Buffer.byteLength(name, 'utf8') < MAX_BYTES, `${Buffer.byteLength(name, 'utf8')} bytes: ${name.slice(0, 80)}...`);
  assert.ok(name.length < MAX_BYTES, `${name.length} chars`);
  assert.ok(name.includes(`[${ID}]`), 'the id is what makes the name unique; it is never the thing truncated');
  assert.ok(name.endsWith('].md'));
});

test('the cap trims the SLUG, not the date or the bracket pair', () => {
  const name = noteName({ id: ID, title: 'y'.repeat(5000), timeCreated: WHEN }, {});
  assert.ok(name.startsWith('2026-01-15 - '));
  assert.equal(name, `2026-01-15 - ${'y'.repeat(MAX_BYTES - 1 - (`2026-01-15 -  [${ID}].md`).length)} [${ID}].md`);
});

test('two long titles sharing a 4000-char prefix are separated by the id, not by the slug', () => {
  const shared = 'z'.repeat(4000);
  const a = noteName({ id: ID, title: shared + ' alpha', timeCreated: WHEN }, {});
  const b = noteName({ id: ID2, title: shared + ' beta', timeCreated: WHEN }, {});
  // The honest statement, and the whole argument for never truncating the id:
  // after truncation these two slugs are byte-identical. The id is the only
  // thing standing between a 4000-character title pair and one overwritten file.
  assert.equal(a.slice(0, a.indexOf(' [')), b.slice(0, b.indexOf(' [')));
  assert.notEqual(a, b);
});

test('a name cut at the cap does not end in a dangling hyphen', () => {
  const name = noteName({ id: ID, title: ('ab-'.repeat(2000)), timeCreated: WHEN }, {});
  assert.ok(!name.includes('- ['), `trailing hyphen left at the cap: ${name.slice(-40)}`);
});

// ---------- 6. uniqueness, idempotence, robustness ----------

test('the same title on two different ids produces two different filenames', () => {
  const a = noteName({ id: ID, title: 'daily standup notes', timeCreated: WHEN }, {});
  const b = noteName({ id: ID2, title: 'daily standup notes', timeCreated: WHEN }, {});
  assert.notEqual(a, b, 'the id is the collision guard; two sessions must never share a file');
  assert.ok(a.includes(ID));
  assert.ok(b.includes(ID2));
});

test('the same id on two different days produces two different filenames', () => {
  const a = noteName({ id: ID, title: 'retry me', timeCreated: Date.UTC(2026, 0, 15, 9, 30, 0) }, {});
  const b = noteName({ id: ID, title: 'retry me', timeCreated: Date.UTC(2026, 0, 16, 9, 30, 0) }, {});
  assert.notEqual(a, b);
});

test('calling twice with the same input returns the identical string', () => {
  const session = { id: ID, title: 'Idempotence Matters', timeCreated: WHEN };
  const opts = { firstUserText: 'ignored because the title exists' };
  assert.equal(noteName(session, opts), noteName(session, opts));
  assert.equal(noteName(session), noteName(session));
});

test('noteName does not mutate its inputs', () => {
  const session = { id: ID, title: 'Do not touch me', timeCreated: WHEN };
  const opts = { firstUserText: 'nor me' };
  noteName(session, opts);
  assert.deepEqual(session, { id: ID, title: 'Do not touch me', timeCreated: WHEN });
  assert.deepEqual(opts, { firstUserText: 'nor me' });
});

// Each bad title carries a literal label: assert.ok builds its message eagerly,
// and String(Symbol()) throws, so an inline template would crash the test for
// the wrong reason.
const BAD_TITLES = [
  ['undefined', undefined],
  ['null', null],
  ['zero', 0],
  ['number', 42],
  ['boolean', true],
  ['object', {}],
  ['array', []],
  ['symbol', Symbol('s')],
  ['function', () => {}],
  ['Date', new Date(0)],
];

test('a non-string or missing title is handled without throwing', () => {
  for (const [label, title] of BAD_TITLES) {
    const name = noteName({ id: ID, title, timeCreated: WHEN }, {});
    assert.equal(typeof name, 'string', `${label} did not produce a string`);
    assert.ok(name.includes(`[${ID}]`), `${label} lost the id`);
    assert.ok(name.endsWith('].md'), `${label} lost the extension`);
  }
});

test('a missing title key is the same as title === null, not a crash', () => {
  const absent = noteName({ id: ID, timeCreated: WHEN }, {});
  assert.equal(absent, noteName({ id: ID, title: null, timeCreated: WHEN }, {}));
  assert.ok(absent.includes(`[${ID}]`));
});

test('a session with no id at all throws rather than inventing a filename', () => {
  // Two un-idable sessions would otherwise produce the same name and the second
  // export would overwrite the first. There is no name that is both valid and
  // unique here, so this is the one case that is allowed to fail loudly.
  assert.throws(() => noteName(undefined, undefined), /id/);
  assert.throws(() => noteName({}, {}), /id/);
});

test('a first prompt longer than any sane note is truncated, not refused', () => {
  const name = noteName(
    { id: ID, title: null, timeCreated: WHEN },
    { firstUserText: `start ${'long '.repeat(4000)}end` },
  );
  assert.ok(Buffer.byteLength(name, 'utf8') < MAX_BYTES, `${Buffer.byteLength(name, 'utf8')} bytes`);
  assert.ok(name.includes(`[${ID}]`));
  // The fixed parts of the format legitimately contain spaces (' - ', ' ['), so
  // the slug segment is inspected on its own.
  const slug = name.slice('2026-01-15 - '.length, name.indexOf(' ['));
  assert.ok(!slug.includes(' '), `the prompt was left as prose: ${slug}`);
  assert.ok(slug.length > 0, 'a 24000-character prompt must not truncate to nothing');
});

test('a session id is required: a nameless note cannot be made unique, so this throws loudly', () => {
  // The alternative is a silent collision that overwrites a real note on the
  // next export. A loud TypeError is the cheaper failure.
  assert.throws(() => noteName({ title: 'orphan', timeCreated: WHEN }, {}), /id/);
  assert.throws(() => noteName({ id: '   ', title: 'orphan', timeCreated: WHEN }, {}), /id/);
});

test('an unusable timestamp throws instead of dating every note 1970', () => {
  assert.throws(() => noteName({ id: ID, title: 't', timeCreated: 'nope' }, {}), /timeCreated/);
  assert.throws(() => noteName({ id: ID, title: 't' }, {}), /timeCreated/);
});

test('MAX_BYTES is the documented filesystem ceiling, not a private number', () => {
  assert.equal(MAX_BYTES, 255);
});