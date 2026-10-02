// scripts/vault-index-narration.test.mjs
//
// Regression suite for the narration filter, a Python script with previously
// zero tests and 251 indexing batches depending on it. Its `NNNNN | ` prefix
// is not decoration: it is what a subagent copies into a graph node's
// `source_location`. A prefix that is off by N is not a cosmetic bug, it is a
// graph full of locations that point at the wrong line.
//
// FIVE BUGS ALREADY SHIPPED IN THIS FILE'S LOGIC. All five were found by
// subagents in production, none by a test, and that is exactly why this file
// exists. Each is pinned below by name:
//
//   bug 1  `## [seq N] assistant` is a SEPARATOR at level 2, not scaffold.
//          Read as scaffold it opens a drop region of level 2; the next
//          heading `### reasoning` is level 3 and does not clear it, so EVERY
//          reasoning body in a transcript is silently dropped while the filter
//          still reports a small, plausible, entirely wrong retention number.
//          This is the one that matters most, so its test asserts the reasoning
//          BODY lines survive, not merely that the heading is echoed back.
//   bug 2  An earlier version classified `reasoning`, `assistant text` and
//          `prompt` as droppable. Exactly backwards: those ARE the content.
//   bug 3  A `[PROSE FENCED]` block has an opening marker and NO closing
//          marker. The first inner fence opens the block and a later
//          same-char equal-or-greater-width fence closes it. An implementation
//          that assumes a closing marker swallows the rest of the file.
//   bug 4  A level<=2 bail-out fired on in-prose headings such as the
//          `# AGENTS.md` heading in a pasted system prompt, and gutted the block.
//   bug 5  Python's universal-newline handling splits on a bare \r as well as
//          \r\n and \n. A transcript with 36 stray carriage returns produced
//          prefixes up to 36 too high (measured: 20957 where the true 1-indexed
//          line was 20921). Fixed by opening the file with newline=''; nothing
//          tested it, which is how it got broken twice.
//
// THE SUITE IS JS, THE SCRIPT IS PYTHON. The repo runs one runner, `bun test
// scripts/`, across 27 files. Rather than add a second runner or a pytest
// dependency, this file drives `python3 <script>` with spawnSync and asserts on
// stdout and stderr. Fixtures are written to a fresh temp dir per test; the
// suite never reads the vault, so it is machine-independent and safe to run
// anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'vault-index-narration.py');

// Write a fixture into its own temp dir and return the handles plus a cleanup.
function fixture(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'vault-narration-'));
  const file = join(dir, 'transcript.md');
  writeFileSync(file, contents, 'utf8');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(file, args = []) {
  const r = spawnSync('python3', [SCRIPT, file, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Turn `NNNNN | body` stdout into [{ n, text }]. An empty `text` is legal: the
// filter emits a prefix for a blank source line, and dropping those would hide
// a line-numbering bug.
function parse(stdout) {
  const out = [];
  const lines = stdout.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const m = /^(\d+) \| ([\s\S]*)$/.exec(line);
    assert.ok(m, `output line is not 'NNNNN | body': ${JSON.stringify(line)}`);
    out.push({ n: Number(m[1]), text: m[2] });
  }
  return out;
}

// The number of lines the file has when split on '\n' alone. This is the
// authority for every prefix assertion, including bug 5's: the prefix exists
// to be a real 1-indexed line number, so it is measured against '\n', never
// against a universal-newline read.
function trueLineCount(contents) {
  return contents.split('\n').length;
}

function keptNums(kept) {
  return kept.map((k) => k.n);
}

function texts(kept) {
  return kept.map((k) => k.text);
}

// ---------- bug 5's fixture corpus ----------

// One transcript exercising every structure in the verified corpus, plus the
// prose-fenced block and the wide fence. Reused by the aggregate properties.
function fullTranscript() {
  return [
    '## [seq 4] user',
    '### prompt',
    'question line one',
    'question line two',
    '## [seq 5] assistant',
    '### assistant text',
    'answer line one',
    '### tool · read',
    '#### input',
    '{"path":"/etc/hostname"}',
    '#### output',
    'tool payload line',
    '### reasoning',
    'reasoning body one',
    'reasoning body two',
    '## [seq 6] user',
    '### prompt',
    'follow-up question',
    '',
  ].join('\n');
}

// ---------- 1. the baseline: a reasoning body survives ----------

test('a plain ### reasoning body survives with its prefix equal to its true line number', () => {
  const contents = ['### reasoning', 'first thought', 'second thought', ''].join('\n');
  const f = fixture(contents);
  try {
    const { status, stdout } = run(f.file);
    assert.equal(status, 0);
    const kept = parse(stdout);
    assert.deepEqual(texts(kept), ['### reasoning', 'first thought', 'second thought', '']);
    assert.deepEqual(keptNums(kept), [1, 2, 3, 4]);
    assert.equal(kept[1].n, 2);
  } finally {
    f.cleanup();
  }
});

// ---------- bug 1: separator vs scaffold ----------

test('bug 1: ### reasoning immediately after `## [seq N] assistant` keeps its body lines', () => {
  // The regression test that matters most. A filter that treats the level-2
  // separator as scaffold opens a drop region of level 2; `### reasoning` is
  // level 3 and does not clear it, so the heading may still be echoed while
  // every line beneath it disappears. Hence: assert the BODY, with prefixes.
  const contents = [
    '## [seq 5] assistant',
    '### reasoning',
    'REASONING-BODY-ALPHA',
    'REASONING-BODY-BETA',
    '## [seq 6] user',
    '### prompt',
    'QUESTION-AFTER',
    '',
  ].join('\n');
  const f = fixture(contents);
  try {
    const { status, stdout, stderr } = run(f.file, ['--stats']);
    assert.equal(status, 0);
    const kept = parse(stdout);

    const alpha = kept.find((k) => k.text === 'REASONING-BODY-ALPHA');
    const beta = kept.find((k) => k.text === 'REASONING-BODY-BETA');
    assert.ok(alpha, 'the first reasoning body line was dropped');
    assert.ok(beta, 'the second reasoning body line was dropped');
    assert.equal(alpha.n, 3);
    assert.equal(beta.n, 4);

    // The separator emits its own line and opens nothing, so the following
    // heading still clears cleanly.
    assert.ok(kept.some((k) => k.text === '## [seq 5] assistant'));
    assert.ok(kept.some((k) => k.text === '### reasoning'));
    assert.ok(kept.some((k) => k.text === 'QUESTION-AFTER'));

    // The reported retention number is the one an operator reads. If bodies go
    // missing the number must move, otherwise the failure stays invisible.
    const reported = Number(/kept\s+(\d+)/.exec(stderr)[1]);
    assert.equal(reported, kept.length);
    assert.ok(
      reported >= 8,
      `only ${reported} of ${trueLineCount(contents)} lines kept; reasoning bodies were dropped`,
    );
  } finally {
    f.cleanup();
  }
});

// ---------- bug 2: narration is the content ----------

test('bug 2: reasoning, assistant text and prompt are never dropped, with or without their bodies', () => {
  for (const title of ['reasoning', 'assistant text', 'prompt']) {
    const contents = [`## [seq 1] assistant`, `### ${title}`, `BODY-OF-${title}`, ''].join('\n');
    const f = fixture(contents);
    try {
      const { status, stdout } = run(f.file);
      assert.equal(status, 0);
      const kept = parse(stdout);
      assert.ok(
        kept.some((k) => k.text === `### ${title}`),
        `heading '### ${title}' was dropped`,
      );
      assert.ok(
        kept.some((k) => k.text === `BODY-OF-${title}`),
        `the body of '### ${title}' was dropped`,
      );
    } finally {
      f.cleanup();
    }
  }
});

// ---------- bug 3: PROSE FENCED has no closing marker ----------

test('bug 3: an unterminated [PROSE FENCED] block yields its content without swallowing the rest of the file', () => {
  // The opening marker is `## [PROSE FENCED] assistant`; there is no matching
  // close. The first inner ``` fence OPENS the block and the later ``` fence
  // CLOSES it. Whatever comes after must survive.
  const contents = [
    '## [PROSE FENCED] assistant',
    '### assistant text',
    'PROSE-BEFORE-FENCE',
    '```js',
    'PROSE-INSIDE-FENCE',
    '```',
    'PROSE-AFTER-FENCE',
    '### reasoning',
    'REASONING-AFTER-PROSE-FENCED',
    '',
  ].join('\n');
  const f = fixture(contents);
  try {
    const { status, stdout } = run(f.file);
    assert.equal(status, 0);
    const kept = parse(stdout);
    for (const needle of [
      'PROSE-BEFORE-FENCE',
      'PROSE-INSIDE-FENCE',
      'PROSE-AFTER-FENCE',
      'REASONING-AFTER-PROSE-FENCED',
    ]) {
      assert.ok(
        kept.some((k) => k.text === needle),
        `'${needle}' was swallowed by the unterminated [PROSE FENCED] block`,
      );
    }
    // And the prefixes past the block are still honest.
    const tail = kept.find((k) => k.text === 'REASONING-AFTER-PROSE-FENCED');
    assert.equal(tail.n, 9);
  } finally {
    f.cleanup();
  }
});

// ---------- bug 4: in-prose headings ----------

test('bug 4: an in-prose `# AGENTS.md` heading does not truncate the block', () => {
  // A pasted system prompt carries its own `#` headings. A level<=2 bail-out
  // treats one of them as the end of the transcript and guts everything after.
  const contents = [
    '### prompt',
    'here is the project instruction file:',
    '# AGENTS.md',
    'PROSE-UNDER-THE-H1',
    '## a second pasted heading',
    'PROSE-UNDER-THE-H2',
    'PROSE-AT-THE-END',
    '',
  ].join('\n');
  const f = fixture(contents);
  try {
    const { status, stdout } = run(f.file);
    assert.equal(status, 0);
    const kept = parse(stdout);
    for (const needle of ['PROSE-UNDER-THE-H1', 'PROSE-UNDER-THE-H2', 'PROSE-AT-THE-END']) {
      assert.ok(
        kept.some((k) => k.text === needle),
        `'${needle}' was truncated by an in-prose heading`,
      );
    }
    assert.ok(kept.some((k) => k.text === '# AGENTS.md'));
    assert.equal(kept.find((k) => k.text === 'PROSE-AT-THE-END').n, 7);
  } finally {
    f.cleanup();
  }
});

// ---------- bug 5: bare carriage returns ----------

test('bug 5: bare \\r never pushes a prefix past the true \\n-split line count', () => {
  // newline='' is what makes this pass. Under Python's default universal
  // newlines these five '\n'-delimited lines read as nine, and every prefix
  // past the first stray \r is inflated.
  const contents = '### prompt\rnoise\r\n### reasoning\r\r\rREASONING-BODY\n### reasoning\nTAIL\n';
  const f = fixture(contents);
  try {
    const { status, stdout } = run(f.file);
    assert.equal(status, 0);
    const kept = parse(stdout);
    const cap = trueLineCount(contents);
    assert.equal(cap, 5, 'fixture is not 5 lines when split on \\n');
    for (const k of kept) {
      assert.ok(
        k.n <= cap,
        `prefix ${k.n} exceeds the true \\n-split line count ${cap}; universal newlines are back`,
      );
    }
    // Not merely bounded: exactly correct. Every emitted prefix must equal the
    // index of the '\n'-split line it came from. The reasoning body rides on
    // line 2 with three stray \r ahead of it, so a universal-newline read would
    // report 5 and the last two lines would report 8 and 9.
    const truth = contents.split('\n');
    for (const k of kept) {
      assert.equal(k.text, truth[k.n - 1], `prefix ${k.n} does not name its own source line`);
    }
    assert.ok(kept.some((k) => k.text.includes('REASONING-BODY')));
    assert.equal(kept.find((k) => k.text === 'TAIL').n, 4);
  } finally {
    f.cleanup();
  }
});

// ---------- scaffold: input/output produce nothing ----------

test('#### input and #### output produce no kept lines, but the heading after them does', () => {
  const contents = [
    '## [seq 5] assistant',
    '### tool · read',
    '#### input',
    '{"path":"/etc/hostname"}',
    '#### output',
    'file payload that nobody needs',
    '### reasoning',
    'REASONING-AFTER-TOOL',
    '',
  ].join('\n');
  const f = fixture(contents);
  try {
    const { status, stdout } = run(f.file);
    assert.equal(status, 0);
    const kept = parse(stdout);
    const t = texts(kept);
    for (const dropped of [
      '#### input',
      '{"path":"/etc/hostname"}',
      '#### output',
      'file payload that nobody needs',
    ]) {
      assert.ok(!t.includes(dropped), `'${dropped}' should have been dropped`);
    }
    // A scaffold heading is a renderer artifact: it is dropped along with its
    // body. What matters is that the region is closed by the next heading and
    // content resumes there.
    assert.ok(!t.includes('### tool · read'));
    assert.ok(t.includes('REASONING-AFTER-TOOL'));
    assert.equal(kept.find((k) => k.text === 'REASONING-AFTER-TOOL').n, 8);
  } finally {
    f.cleanup();
  }
});

// ---------- fence width ----------

test('a 4-backtick fence is not closed by a 3-backtick line', () => {
  // A fence closes only on the same character AND at least the same width.
  // Otherwise the nested ``` lines end the block early and the real prose
  // after them gets parsed as headings.
  const contents = [
    '### assistant text',
    '````markdown',
    '```',
    'NESTED-THREE-A',
    '```',
    'NESTED-THREE-B',
    '````',
    '### reasoning',
    'REASONING-AFTER-WIDE-FENCE',
    '',
  ].join('\n');
  const f = fixture(contents);
  try {
    const { status, stdout } = run(f.file);
    assert.equal(status, 0);
    const kept = parse(stdout);
    const t = texts(kept);
    // Nothing inside the wide fence is dropped, fence markers included. Assert
    // the WHOLE fixture survives rather than just the sentinel words: when the
    // width rule is relaxed, the inner ``` lines close the block early and the
    // fence lines themselves vanish, while the prose between them survives and
    // the damage stays invisible to a sentinel-only check.
    // The exact kept set, not just the sentinel words. Only the CLOSING fence
    // marker is consumed by the block; every other line, nested ``` markers
    // included, survives. When the width rule is relaxed the inner ``` lines
    // close the block early, those lines disappear, and a second fence opens at
    // line 5 -- same prose, different prefixes, no error anywhere. Only an exact
    // set assertion sees it.
    assert.deepEqual(
      keptNums(kept),
      [1, 2, 3, 4, 5, 6, 8, 9, 10],
      'the wrong lines were kept: a 3-backtick line closed a 4-backtick fence',
    );
    assert.ok(t.includes('NESTED-THREE-A') && t.includes('NESTED-THREE-B'));
    assert.ok(t.includes('REASONING-AFTER-WIDE-FENCE'));
    assert.equal(kept.find((k) => k.text === 'REASONING-AFTER-WIDE-FENCE').n, 9);
  } finally {
    f.cleanup();
  }
});

// ---------- robustness ----------

test('a backtick fence is not closed by a tilde fence of equal or greater width', () => {
  // The other half of the closing rule: same CHARACTER as well as same width.
  // A `~~~` block containing a ``` line is common in transcripts quoting shell
  // output, and dropping its tail loses prose silently.
  const contents = [
    '### assistant text',
    '~~~text',
    '```',
    'TILDE-BLOCK-CONTENT',
    '```',
    '~~~',
    '### reasoning',
    'REASONING-AFTER-TILDE',
    '',
  ].join('\n');
  const f = fixture(contents);
  try {
    const { status, stdout } = run(f.file);
    assert.equal(status, 0);
    const kept = parse(stdout);
    assert.ok(kept.some((k) => k.text === 'TILDE-BLOCK-CONTENT'));
    assert.ok(kept.some((k) => k.text === 'REASONING-AFTER-TILDE'));
    // Exact kept set. Only the closing `~~~` is consumed; the inner ``` lines
    // are content. If the character rule is dropped, line 3 closes the block
    // early and disappears -- and every sentence in the file still reads
    // correctly, so a presence-only check cannot see it.
    assert.deepEqual(keptNums(kept), [1, 2, 3, 4, 5, 7, 8, 9]);
    assert.equal(kept.find((k) => k.text === 'REASONING-AFTER-TILDE').n, 8);
  } finally {
    f.cleanup();
  }
});

test('an unclosed fence at end of file does not crash', () => {
  const contents = ['### assistant text', 'BODY', '```', 'CODE-UNDER-UNCLOSED-FENCE', ''].join('\n');
  const f = fixture(contents);
  try {
    const { status, stdout, stderr } = run(f.file);
    assert.equal(status, 0, `exit ${status}, stderr: ${stderr}`);
    assert.equal(stderr, '');
    const kept = parse(stdout);
    assert.ok(kept.some((k) => k.text === 'CODE-UNDER-UNCLOSED-FENCE'));
    assert.equal(kept.find((k) => k.text === 'CODE-UNDER-UNCLOSED-FENCE').n, 4);
  } finally {
    f.cleanup();
  }
});

test('a file that is only scaffold emits nothing and exits 0', () => {
  const contents = ['## [seq 1] assistant', '### tool · bash', '#### input', '{"cmd":"ls"}', ''].join('\n');
  const f = fixture(contents);
  try {
    const { status, stdout } = run(f.file);
    assert.equal(status, 0);
    // Only the separator survives. The trailing blank line is inside the
    // `#### input` drop region, so it goes too -- assert precisely, because
    // "output is not empty" is a weaker claim than "output is exactly this".
    assert.deepEqual(texts(parse(stdout)), ['## [seq 1] assistant']);
  } finally {
    f.cleanup();
  }
});

// ---------- aggregate properties over the whole corpus ----------

test('every emitted prefix is an integer and monotonically non-decreasing', () => {
  const f = fixture(fullTranscript());
  try {
    const { status, stdout } = run(f.file);
    assert.equal(status, 0);
    const kept = parse(stdout);
    assert.ok(kept.length > 0);
    for (let i = 0; i < kept.length; i += 1) {
      const k = kept[i];
      assert.ok(Number.isInteger(k.n), `prefix ${k.n} is not an integer`);
      assert.ok(k.n >= 1, `prefix ${k.n} is not 1-indexed`);
      if (i > 0) {
        assert.ok(
          kept[i].n > kept[i - 1].n,
          `prefix went backwards or repeated: ${kept[i - 1].n} then ${kept[i].n}`,
        );
      }
      assert.ok(k.n <= trueLineCount(fullTranscript()), `prefix ${k.n} past end of file`);
    }
  } finally {
    f.cleanup();
  }
});

test('output is byte-for-byte deterministic across two runs', () => {
  const f = fixture(fullTranscript());
  try {
    const a = run(f.file, ['--stats']);
    const b = run(f.file, ['--stats']);
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    assert.equal(a.stdout, b.stdout);
    assert.equal(a.stderr, b.stderr);
    // Guard against the degenerate pass: a deterministic empty output.
    assert.ok(parse(a.stdout).length > 5);
  } finally {
    f.cleanup();
  }
});

test('--stats totals add up against the full corpus', () => {
  const contents = fullTranscript();
  const f = fixture(contents);
  try {
    const { status, stdout, stderr } = run(f.file, ['--stats']);
    assert.equal(status, 0);
    const kept = parse(stdout);
    // Drop counters are printed with a leading '-', so allow optional padding
    // and sign before the digits.
    const field = (label) => {
      const m = new RegExp(`^\\s*${label}\\s+(-?)\\s*(\\d+)`, 'm').exec(stderr);
      assert.ok(m, `no '${label}' row in --stats output:\n${stderr}`);
      return Number(m[2]);
    };
    const total = field('total');
    const keptCount = field('kept');
    const traffic = field('tool traffic');
    const fenced = field('fenced dropped');
    const scaffold = Number(/scaffold hdg x\s*(\d+)/.exec(stderr)[1]);
    assert.equal(total, trueLineCount(contents));
    assert.equal(keptCount, kept.length);
    // Conservation, with one wrinkle worth naming: a scaffold heading line is
    // dropped (its `continue` never reaches either drop counter) but IS counted
    // under `scaffold hdg`. So the naive kept+dropped sum is short by exactly
    // the scaffold heading count, and the honest identity includes it.
    assert.equal(total, keptCount + traffic + fenced + scaffold);
    assert.ok(scaffold > 0, 'fixture has no scaffold, so this proves nothing');
  } finally {
    f.cleanup();
  }
});
