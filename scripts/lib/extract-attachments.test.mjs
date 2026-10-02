// scripts/lib/extract-attachments.test.mjs
//
// Guards for the attachment extractor.
//
// OpenCode stores user attachments INLINE in the session JSON, not as paths:
// a `user` message in `session_message.data` carries `files[]` and each entry
// has a base64 `data` field (a real one starts `iVBORw0KGgo...`). So the
// extractor's whole job is turning those strings into real files on disk that
// a note can embed.
//
// Four failure modes are worth protecting, and none of them is "the bytes were
// written":
//
//   * A file that does not exist. An embed pointing at nothing renders as a
//     broken link forever, and the note looks fine in the source.
//   * A wrong extension. OpenCode gives no trustworthy name, so the extension
//     has to come from the magic bytes. `.png` on a JPEG makes Obsidian's
//     preview fail and, worse, makes the file look like evidence when it is
//     not.
//   * A filename that moves between runs. Re-running the import must not churn
//     the vault, so the name is a pure function of (context, content).
//   * The base64 string itself leaking into a note. It is megabytes of noise
//     and it is the single most destructive thing this code could emit, so
//     there is a test that fails if any of it survives into the return value.
//
// Every fixture is a throwaway directory under tmpdir. Nothing here reads the
// real vault and nothing here writes outside tmpdir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import {
  extractAttachments,
  sniffExtension,
  FALLBACK_EXT,
} from './extract-attachments.mjs';

// ---------- fixtures ----------

// A minimal but genuinely valid PNG, assembled rather than pasted: signature,
// one IHDR, one IDAT (zlib-compressed raw scanline), IEND. Building it here
// means the "the bytes on disk are the real decoded bytes" assertion is about
// bytes this file understands, not about a base64 blob of unknown provenance.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(width = 1, height = 1, rgb = [0xff, 0x00, 0x00]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const rows = [];
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0])); // filter type: none
    for (let x = 0; x < width; x++) {
      // rgb === null means "a pattern", which deflate cannot squash into a few
      // bytes. A long payload is what makes the leak test's substring scan
      // meaningful, so the fixtures that need length ask for one.
      rows.push(Buffer.from(rgb === null
        ? [(x * 17) & 0xff, (y * 29) & 0xff, ((x + y) * 11) & 0xff]
        : rgb));
    }
  }
  // The scanline bytes are the IDAT payload; they were being built into
  // `rows` inline and never bound to a name, so `deflateSync(raw)` threw
  // ReferenceError and every fixture-dependent test failed at once.
  const raw = Buffer.concat(rows);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Only the leading marker has to be real for the sniffer; the tail is filler.
function makeJpeg() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from([0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]),
    Buffer.alloc(64, 0x20),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function makeGif() {
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff]),
    Buffer.alloc(16, 0x00),
  ]);
}

function makeWebp() {
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(20, 4); // file size - 8, a value nothing here checks
  return Buffer.concat([
    head,
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8 ', 'ascii'),
    Buffer.alloc(12, 0x00),
  ]);
}

function makePdf() {
  return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'ascii');
}

const b64 = (buf) => buf.toString('base64');

function sandbox(tag) {
  const base = mkdtempSync(path.join(tmpdir(), `attach-${tag}-`));
  return { base, vault: base, dest: path.join(base, '99 - Assets', 'attachments') };
}

const cleanup = (f) => rmSync(f.base, { recursive: true, force: true });

// ---------- 1. the bytes actually land on disk ----------

test('a base64 PNG is decoded, written under destDir, and the bytes on disk are the decoded bytes', () => {
  const f = sandbox('write');
  try {
    const png = makePng();
    const out = extractAttachments([{ filename: 'shot.png', data: b64(png) }], f.dest, {
      sessionId: 'ses_20260926_abc',
      messageId: 'msg_0007',
    });

    assert.equal(out.length, 1);
    const [a] = out;
    assert.equal(a.index, 0);
    assert.equal(a.bytes, png.length, 'byte length must be the decoded length, not the base64 length');
    assert.equal(path.dirname(a.path), f.dest, 'the file must land directly in destDir');
    assert.ok(existsSync(a.path), `expected ${a.path} to exist`);
    assert.ok(statSync(a.path).isFile());
    assert.deepEqual(readFileSync(a.path), png, 'what is on disk is not what was decoded');

    // And the file is recognisable as the thing it claims to be.
    assert.equal(sniffExtension(readFileSync(a.path)), '.png');
    assert.match(path.basename(a.path), /\.png$/);
  } finally {
    cleanup(f);
  }
});

test('destDir is created recursively, including when the parent does not exist yet', () => {
  const f = sandbox('mkdir');
  try {
    assert.equal(existsSync(f.dest), false, 'fixture precondition: destDir starts absent');
    extractAttachments([{ data: b64(makePng()) }], f.dest, { sessionId: 's', messageId: 'm' });
    assert.ok(statSync(f.dest).isDirectory());
    assert.equal(readdirSync(f.dest).length, 1);
  } finally {
    cleanup(f);
  }
});

test('an empty files array writes nothing and does not create a directory', () => {
  const f = sandbox('empty');
  try {
    const out = extractAttachments([], f.dest, { sessionId: 's', messageId: 'm' });
    assert.deepEqual(out, []);
    assert.equal(existsSync(f.dest), false);
  } finally {
    cleanup(f);
  }
});

// ---------- 2. the extension comes from the content ----------

test('the extension is sniffed from magic bytes: PNG, JPEG, GIF, WEBP, PDF', () => {
  const f = sandbox('sniff');
  try {
    const cases = [
      [makePng(), '.png'],
      [makeJpeg(), '.jpg'],
      [makeGif(), '.gif'],
      [makeWebp(), '.webp'],
      [makePdf(), '.pdf'],
    ];
    const out = extractAttachments(cases.map(([buf]) => ({ data: b64(buf) })), f.dest, {
      sessionId: 'ses_mixed',
      messageId: 'msg_0001',
    });

    assert.equal(out.length, cases.length);
    out.forEach((a, i) => {
      assert.equal(sniffExtension(cases[i][0]), cases[i][1]);
      assert.equal(
        path.extname(a.filename),
        cases[i][1],
        `entry ${i} should be ${cases[i][1]}, got ${path.extname(a.filename)}`,
      );
    });
    // Five distinct content types, five distinct files.
    assert.equal(new Set(out.map((a) => a.filename)).size, 5);
  } finally {
    cleanup(f);
  }
});

test('a supplied name cannot dictate the extension: a PNG called .jpg is still written as .png', () => {
  const f = sandbox('liar');
  try {
    const png = makePng();
    const out = extractAttachments([{ filename: 'actually-a-png.jpg', data: b64(png) }], f.dest, {
      sessionId: 'ses_liar',
      messageId: 'msg_0002',
    });
    assert.equal(path.extname(out[0].filename), '.png');
    assert.deepEqual(readFileSync(out[0].path), png);
  } finally {
    cleanup(f);
  }
});

test('unrecognised bytes fall back to the documented extension instead of throwing', () => {
  const f = sandbox('unknown');
  try {
    const junk = Buffer.from('this is not an image, it is a sentence.');
    const out = extractAttachments([{ filename: 'mystery', data: b64(junk) }], f.dest, {
      sessionId: 'ses_junk',
      messageId: 'msg_0003',
    });
    assert.equal(out.length, 1, 'an unrecognised type is still a written attachment');
    assert.equal(FALLBACK_EXT, '.bin', 'the fallback is documented and exported, not a magic string');
    assert.equal(path.extname(out[0].filename), FALLBACK_EXT);
    assert.ok(existsSync(out[0].path));
    assert.deepEqual(readFileSync(out[0].path), junk, 'the bytes are preserved verbatim even when unrecognised');
  } finally {
    cleanup(f);
  }
});

// ---------- 3. deterministic, collision-free filenames ----------

test('the filename is a pure function of context and content: the same input gives the same name', () => {
  const f = sandbox('determinism');
  try {
    const png = makePng();
    const entry = [{ filename: 'shot.png', data: b64(png) }];
    const opts = { sessionId: 'ses_det', messageId: 'msg_0009' };

    const first = extractAttachments(entry, f.dest, opts);
    const second = extractAttachments(entry, f.dest, opts);

    assert.equal(first[0].filename, second[0].filename, 're-running the import must not churn the vault');
    assert.equal(first[0].path, second[0].path);
    assert.equal(first[0].embed, second[0].embed);
    // The second run overwrites the same path rather than adding a file.
    assert.equal(readdirSync(f.dest).length, 1);
    assert.deepEqual(readFileSync(first[0].path), png, 'an idempotent rewrite is still byte-correct');
  } finally {
    cleanup(f);
  }
});

test('two different images never collide, even in the same message with the same index shape', () => {
  const f = sandbox('collision');
  try {
    const a = makePng(1, 1, [0xff, 0x00, 0x00]);
    const b = makePng(1, 1, [0x00, 0x00, 0xff]); // same size, different pixels
    assert.equal(a.length, b.length, 'the two fixtures differ only in content, not in length');

    const out = extractAttachments(
      [{ filename: 'one.png', data: b64(a) }, { filename: 'two.png', data: b64(b) }],
      f.dest,
      { sessionId: 'ses_coll', messageId: 'msg_0004' },
    );

    assert.notEqual(out[0].filename, out[1].filename, 'two different images got the same filename');
    assert.notEqual(out[0].path, out[1].path);
    assert.equal(readdirSync(f.dest).length, 2);
    assert.deepEqual(readFileSync(out[0].path), a, 'file 0 holds image a');
    assert.deepEqual(readFileSync(out[1].path), b, 'file 1 holds image b');
    // Same length, same declared type, same declared name shape: only the
    // content differs. If the filename were built from size or extension
    // instead of the hash, these two would have been one file.
    assert.equal(a.length, b.length);
    assert.equal(path.extname(out[0].filename), path.extname(out[1].filename));

    // The harder half, and the one an index-based name cannot pass: two
    // SEPARATE calls that share context exactly. Position cannot distinguish
    // them, because both are index 0 of the same message. This is what an
    // amended or re-sent message looks like, and without the content hash the
    // second import would silently overwrite the first one's file.
    const other = path.join(f.base, 'other');
    const first = extractAttachments([{ data: b64(a) }], other, { sessionId: 'ses_coll', messageId: 'msg_0004' });
    const secondRun = extractAttachments([{ data: b64(b) }], other, { sessionId: 'ses_coll', messageId: 'msg_0004' });
    assert.notEqual(first[0].filename, secondRun[0].filename, 'same context, different content, same filename');
    assert.equal(readdirSync(other).length, 2, 'the second image overwrote the first');
    assert.deepEqual(readFileSync(first[0].path), a);
    assert.deepEqual(readFileSync(secondRun[0].path), b);
  } finally {
    cleanup(f);
  }
});

// ---------- 4. the name from the session log is never trusted ----------

test('a traversal name like ../../evil.png cannot escape destDir', () => {
  const f = sandbox('traversal');
  try {
    const png = makePng();
    const out = extractAttachments([{ filename: '../../evil.png', data: b64(png) }], f.dest, {
      sessionId: 'ses_evil',
      messageId: 'msg_0005',
    });

    assert.equal(out.length, 1);
    const [a] = out;
    // The filename itself carries no separator and no parent reference, so
    // there is nothing for a join() to resolve away.
    assert.ok(!a.filename.includes('/'), `filename contains a slash: ${a.filename}`);
    assert.ok(!a.filename.includes(path.sep), `filename contains a separator: ${a.filename}`);
    assert.ok(!a.filename.includes('..'), `filename contains '..': ${a.filename}`);
    assert.equal(path.basename(a.filename), a.filename);
    assert.ok(!path.isAbsolute(a.filename));

    // The write landed inside destDir...
    assert.equal(path.dirname(a.path), f.dest);
    assert.ok(existsSync(a.path));
    assert.deepEqual(readFileSync(a.path), png);

    // ...and nothing escaped. destDir is the only thing that exists in the
    // vault root, so any traversal would have put a sibling there.
    assert.deepEqual(readdirSync(f.vault), ['99 - Assets']);
    assert.equal(existsSync(path.join(f.vault, 'evil.png')), false);
    assert.equal(existsSync(path.join(f.base, 'evil.png')), false);
  } finally {
    cleanup(f);
  }
});

test('an absolute name, a bare dot name, and a name with no basename all stay inside destDir', () => {
  const f = sandbox('names');
  try {
    const names = ['/etc/passwd.png', '..', '.', '', 'sub/dir/nested.png', 'a\\b.png'];
    const out = extractAttachments(
      names.map((filename) => ({ filename, data: b64(makePng()) })),
      f.dest,
      { sessionId: 'ses_names', messageId: 'msg_0006' },
    );

    assert.equal(out.length, names.length);
    for (const a of out) {
      assert.equal(path.basename(a.filename), a.filename, `${a.filename} is not a bare basename`);
      assert.ok(!a.filename.includes('..'), `${a.filename} contains '..'`);
      assert.equal(path.dirname(a.path), f.dest, `${a.filename} escaped destDir`);
      assert.ok(existsSync(a.path));
    }
    // Six entries, six identical images with the same context: they collapse
    // onto one file rather than six copies. Different names, same content.
    assert.ok(readdirSync(f.dest).length <= names.length);
  } finally {
    cleanup(f);
  }
});

// ---------- 5. AC-7: the base64 never reaches note text ----------

test('the returned objects carry no trace of the base64 payload', () => {
  const f = sandbox('leak');
  try {
    const png = makePng(24, 24, null);
    const data = b64(png);
    assert.ok(data.length > 200, `fixture precondition: payload is ${data.length} chars, too short for the substring scan to mean anything`);

    const out = extractAttachments([{ filename: 'leak.png', data }], f.dest, {
      sessionId: 'ses_leak',
      messageId: 'msg_0008',
    });

    const serialised = JSON.stringify(out);
    assert.ok(!serialised.includes(data), 'the whole payload is present in the return value');

    // Substring, not equality: a truncated or reformatted payload is the same
    // defect. 48 chars is the shortest run that cannot appear by accident in a
    // hash or a path.
    for (const width of [64, 48]) {
      for (let i = 0; i + width <= data.length; i += Math.floor(data.length / 4)) {
        const slice = data.slice(i, i + width);
        assert.ok(!serialised.includes(slice), `payload slice at ${i} (${width} chars) leaked into the return value`);
      }
    }

    // The embed is the only string a caller pastes into a note, so it gets its
    // own check rather than relying on the serialisation above.
    for (const a of out) {
      assert.match(a.embed, /^!\[\[[^\]]+\]\]$/);
      assert.ok(!a.embed.includes(data.slice(0, 48)));
      assert.ok(!a.embed.toLowerCase().includes('/9j/'), 'a JPEG payload prefix reached the embed');
    }
  } finally {
    cleanup(f);
  }
});

// ---------- 6. the embed is a wikilink, because this vault is a wikilink vault ----------

test('the embed is a wikilink with a vault-relative forward-slash path', () => {
  const f = sandbox('embed');
  try {
    const out = extractAttachments([{ data: b64(makePng()) }], f.dest, {
      sessionId: 'ses_embed',
      messageId: 'msg_0010',
      vaultRoot: f.vault,
    });
    const [a] = out;

    assert.match(a.embed, /^!\[\[99 - Assets\/attachments\/[^/]+\.png\]\]$/, `unexpected embed: ${a.embed}`);
    assert.ok(!a.embed.includes('\\'), 'wikilink paths are forward-slash even on Linux-only runs');
    assert.ok(!a.embed.includes(f.base), 'the embed must be relative to the vault root, not absolute');
    // The target of the embed is exactly the file that was written.
    const target = a.embed.slice(3, -2);
    assert.equal(path.resolve(f.vault, target), path.resolve(a.path));
    assert.ok(existsSync(path.resolve(f.vault, target)), 'the embed points at a file that does not exist');
  } finally {
    cleanup(f);
  }
});

// ---------- 7. broken entries are reported, never thrown ----------

test('invalid, empty and missing base64 are reported as skipped entries and do not throw', () => {
  const f = sandbox('invalid');
  try {
    const good = makePng();
    const reported = [];
    const out = extractAttachments(
      [
        { filename: 'ok.png', data: b64(good) },
        { filename: 'empty.png', data: '' },
        { filename: 'whitespace.png', data: '   ' },
        { filename: 'missing.png' },
        { filename: 'garbage.png', data: 'not valid base64 !!!' },
        // One character short of a whole group. A lenient decoder
        // (`Buffer.from(s, 'base64')`) happily returns 3 fewer bytes here and
        // the caller gets a truncated file that still looks like an image.
        { filename: 'truncated.png', data: b64(good).slice(0, b64(good).length - 3) },
        // Seven characters, so the last one carries four bits that belong to no
        // byte. Verified on this runtime: Buffer.from gives 89504e470d and
        // re-encodes to iVBORw0, not to what came in.
        { filename: 'dirtybits.png', data: 'iVBORw1' },
        { filename: 'notastring.png', data: 12345 },
      ],
      f.dest,
      { sessionId: 'ses_bad', messageId: 'msg_0011', onSkip: (entry) => reported.push(entry) },
    );

    assert.equal(out.length, 8, 'every entry gets a result, so index alignment survives a skip');
    const skipped = out.filter((a) => a.skipped);
    assert.equal(skipped.length, 7, 'only the good PNG survives');
    for (const a of skipped) {
      assert.equal(a.filename, null, 'a skipped entry has no filename to embed');
      assert.equal(a.path, null);
      assert.equal(a.embed, null);
      assert.equal(a.bytes, 0);
      assert.ok(typeof a.reason === 'string' && a.reason.length > 0, 'a skip without a reason is a silent loss');
    }
    assert.equal(out[0].skipped, false, 'a written entry is not also marked skipped');
    assert.ok(existsSync(out[0].path), 'one bad entry must not take the good ones down with it');

    // Each skip names its index and the reason, so the caller can print
    // "3 of 7 attachments could not be read" and be right.
    assert.equal(reported.length, 7);
    assert.deepEqual(reported.map((r) => r.index), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(reported.every((r) => r.reason));
  } finally {
    cleanup(f);
  }
});

test('an entry that is already a plain path string is handled without throwing', () => {
  const f = sandbox('pathstring');
  try {
    // Defensive: if some future version of the session log stores a path
    // instead of inline bytes, the extractor must report it rather than
    // crash the import of a 74-message session.
    const out = extractAttachments(
      ['/home/someone/Pictures/holiday.png', { data: b64(makePng()) }],
      f.dest,
      { sessionId: 'ses_paths', messageId: 'msg_0012' },
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].skipped, true);
    assert.match(out[0].reason, /path|not/i, `unhelpful reason: ${out[0].reason}`);
    assert.equal(out[1].skipped, false, 'the inline entry beside it is unaffected');
    assert.ok(existsSync(out[1].path));
  } finally {
    cleanup(f);
  }
});

test('a data-URI payload is decoded, not taken literally', () => {
  const f = sandbox('datauri');
  try {
    const png = makePng();
    const out = extractAttachments(
      [{ filename: 'uri.png', data: `data:image/png;base64,${b64(png)}` }],
      f.dest,
      { sessionId: 'ses_uri', messageId: 'msg_0013' },
    );
    assert.equal(out[0].skipped, false, 'the data-URI prefix must not make it look like invalid base64');
    assert.deepEqual(readFileSync(out[0].path), png);
  } finally {
    cleanup(f);
  }
});

test('an unwritable destDir raises, because that is a real failure and not a per-entry skip', () => {
  const f = sandbox('unwritable');
  try {
    const blocker = path.join(f.base, 'blocker');
    writeFileSync(blocker, 'i am a file, not a directory');
    // destDir is a path through a file, so mkdir cannot succeed. Verified on
    // this runtime: mkdirSync(dest, {recursive: true}) throws ENOTDIR here
    // (it does not silently succeed, which was the first version of this test's
    // assumption and was wrong).
    assert.throws(
      () => extractAttachments([{ data: b64(makePng()) }], path.join(blocker, 'nope'), {
        sessionId: 'ses_x',
        messageId: 'msg_x',
      }),
      /ENOTDIR|EEXIST|File exists/,
      'a broken destination must not be reported as a skipped attachment',
    );
  } finally {
    cleanup(f);
  }
});