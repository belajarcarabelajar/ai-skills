import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classify, buildRequest, readCassette, writeCassette, deriveVerdict, CASSETTE_VERSION } from './spike-jev-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('buildRequest asks exactly one question, with both classes as criteria', () => {
  const body = buildRequest('bun test scripts/x.test.mjs');
  assert.equal(body.model, 'jev-latest');
  assert.equal(typeof body.state, 'string');
  assert.equal(body.state.includes('bun test scripts/x.test.mjs'), true, 'the command must reach the model');
  const ids = Object.keys(body.questions);
  assert.equal(ids.length, 1, 'one decision, one question; extra questions cost tokens and add no evidence');
  const q = body.questions[ids[0]];
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria).sort(), ['behavioural', 'loose']);
});

test('buildRequest describes the classes in the words the runner uses', () => {
  const body = buildRequest('x');
  const q = body.questions[Object.keys(body.questions)[0]];
  const text = JSON.stringify(q.criteria).toLowerCase();
  // If the criteria disagree with the production rule's own comments, the
  // model is being asked a different question than the one the code answers.
  assert.match(text, /run|fail|behaviour/);
  assert.match(text, /string|present|file/);
});

test('buildRequest refuses a command that is not a string', () => {
  assert.throws(() => buildRequest(undefined), /command/i);
  assert.throws(() => buildRequest(''), /command/i);
});

test('readCassette returns an empty store for a missing file', () => {
  const store = readCassette(path.join(ROOT, 'spike-out', 'does-not-exist.json'));
  // Same shape as a written cassette, so a caller never has to branch on
  // whether the file happens to exist yet.
  assert.deepEqual(store, { version: CASSETTE_VERSION, entries: {} });
});

test('writeCassette then readCassette round-trips, and sorts keys for a stable diff', () => {
  const file = path.join(ROOT, 'spike-out', 'cassette.test.json');
  const store = {
    version: CASSETTE_VERSION,
    entries: { b: { choice: 'loose' }, a: { choice: 'behavioural' } },
  };
  writeCassette(file, store);
  const back = readCassette(file);
  assert.equal(back.version, CASSETTE_VERSION);
  assert.equal(back.entries.a.choice, 'behavioural');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.indexOf('"a"') < raw.indexOf('"b"'), 'keys must be sorted so a re-record produces a clean diff');
  fs.rmSync(file, { force: true });
});

test('readCassette rejects a cassette from an unknown version', () => {
  const file = path.join(ROOT, 'spike-out', 'cassette-bad.test.json');
  fs.writeFileSync(file, JSON.stringify({ version: 'nope', entries: {} }));
  try {
    assert.throws(() => readCassette(file), /version/i);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('deriveVerdict scores a Choice answer against the reference label', () => {
  const answer = {
    choice: 'loose',
    confidence: 0.8,
    probabilities: { loose: 0.82, behavioural: 0.18 },
  };
  const v = deriveVerdict(answer, 'loose');
  assert.equal(v.predicted, 'loose');
  assert.equal(v.correct, true);
  assert.equal(v.p, 0.82, 'the probability scored must be the one Jev assigned to the class it chose');
  assert.equal(v.confidence, 0.8);
});

test('deriveVerdict marks a wrong answer correct=false and keeps the probability', () => {
  const answer = {
    choice: 'behavioural',
    confidence: 0.9,
    probabilities: { behavioural: 0.95, loose: 0.05 },
  };
  const v = deriveVerdict(answer, 'loose');
  assert.equal(v.correct, false);
  assert.equal(v.p, 0.95);
});

test('deriveVerdict rejects a response missing the probabilities it needs', () => {
  assert.throws(() => deriveVerdict({ choice: 'loose' }, 'loose'), /probabilit/i);
  assert.throws(() => deriveVerdict({ choice: 'nonsense', probabilities: {} }, 'loose'), /class/i);
  assert.throws(() => deriveVerdict(null, 'loose'), /answer/i);
});

test('classify in test mode needs no API key and performs no network call', async () => {
  // The negative control for the T3 precondition. It runs in-process rather
  // than re-invoking `bun test` on this file, which would recurse: a test that
  // spawns the suite containing it runs forever.
  const env = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const out = await classify('bun test scripts/x.test.mjs', { mode: 'test' });
    assert.equal(out.model, 'stub');
    assert.equal(out.replayed, false);
    assert.equal(out.answer.choice, 'behavioural');
  } finally {
    if (env !== undefined) process.env.TYPESAFE_API_KEY = env;
  }
});

test('classify in live mode refuses to run without a key', async () => {
  const env = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    // A fetch that must never be called. If the key check regressed, this stub
    // records the call and the test fails on the flag instead of hitting the
    // network.
    let called = false;
    const fetchImpl = async () => { called = true; throw new Error('network must not be reached'); };
    await assert.rejects(
      () => classify('bun test x', { mode: 'live', fetchImpl }),
      /E_PRECOND_APIKEY/,
    );
    assert.equal(called, false);
  } finally {
    if (env !== undefined) process.env.TYPESAFE_API_KEY = env;
  }
});

test('classify in replay mode uses the cassette and never the network', async () => {
  const file = path.join(ROOT, 'spike-out', 'cassette-replay.test.json');
  const key = crypto.createHash('sha256').update('bun test a', 'utf8').digest('hex').slice(0, 16);
  writeCassette(file, {
    version: CASSETTE_VERSION,
    entries: {
      [key]: {
        cmd: 'bun test a',
        answer: { choice: 'loose', confidence: 0.7, probabilities: { loose: 0.7, behavioural: 0.3 } },
        model: 'jev-1.13.0',
        latencyMs: 12,
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    },
  });
  try {
    let called = false;
    const fetchImpl = async () => { called = true; throw new Error('network must not be reached'); };
    const out = await classify('bun test a', { mode: 'replay', cassette: file, fetchImpl });
    assert.equal(out.replayed, true);
    assert.equal(out.answer.choice, 'loose');
    assert.equal(out.model, 'jev-1.13.0');
    assert.equal(called, false, 'replay must not reach the network');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
