#!/usr/bin/env node
// Spike T3 — Jev client.
//
// Four modes so the probe in T4 is re-runnable without a secret and without
// re-spending tokens:
//   test    no I/O, no key, fixed stub
//   live    POST to the TypeSafe endpoint
//   record  live, appending the raw response to the cassette
//   replay  read the cassette, no network
//
// The API key is read from the environment at call time and is never written to
// disk, never logged, and never placed in the cassette.
//
// The criteria below are written in the same words `ultra-plan-runner.mjs` uses
// for the same distinction. If they drift, the model is answering a different
// question than the one the code answers, and the agreement number in T4 stops
// measuring anything.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const CASSETTE_VERSION = 1;
const CLASSES = ['behavioural', 'loose'];

export function buildRequest(cmd) {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    throw new Error('buildRequest: a non-empty command string is required');
  }
  return {
    model: 'jev-latest',
    state: `A code plan declared this command as an idempotency check (skip_if). Classify what the command actually does.\n\nCommand:\n${cmd.trim()}`,
    questions: {
      classification: {
        type: 'choice',
        instructions:
          'Does this command run a tool that can fail on behaviour, or does it only read a file and prove a string or a file is present?',
        criteria: {
          behavioural:
            'The command runs something whose exit status depends on behaviour — a test runner, a build, a git query, a script, or any tool that must succeed. It would fail if the behaviour it checks regressed.',
          loose:
            'The command only reads the filesystem and proves that a string, a marker, or a file is present, using tools like grep, rg, cat, head, ls, find, wc, or a bare test -f. It can still exit 0 after the behaviour it appears to check was reverted.',
        },
      },
    },
  };
}

export function readCassette(file) {
  if (!fs.existsSync(file)) return { version: CASSETTE_VERSION, entries: {} };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.version !== CASSETTE_VERSION) {
    throw new Error(`readCassette: cassette version ${parsed.version} is not ${CASSETTE_VERSION}; re-record it`);
  }
  return parsed;
}

export function writeCassette(file, store) {
  const entries = Object.fromEntries(Object.entries(store.entries || {}).sort(([a], [b]) => (a < b ? -1 : 1)));
  const sorted = { version: CASSETTE_VERSION, entries };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
}

export function deriveVerdict(answer, referenceLabel) {
  if (!answer || typeof answer !== 'object') {
    throw new Error('deriveVerdict: no answer object was returned');
  }
  if (!answer.probabilities || typeof answer.probabilities !== 'object') {
    throw new Error('deriveVerdict: the answer carries no probabilities, so it cannot be scored');
  }
  const predicted = answer.choice;
  if (!CLASSES.includes(predicted)) {
    throw new Error(`deriveVerdict: "${predicted}" is not one of the two known classes`);
  }
  const p = answer.probabilities[predicted];
  if (typeof p !== 'number' || Number.isNaN(p)) {
    throw new Error(`deriveVerdict: no probability for the chosen class "${predicted}"`);
  }
  return { predicted, correct: predicted === referenceLabel, p, confidence: answer.confidence };
}

function cassetteKey(cmd) {
  return crypto.createHash('sha256').update(cmd, 'utf8').digest('hex').slice(0, 16);
}

// Fetch exists so the probe can inject it. A module-level fetch captured at
// import time cannot be replaced by a test, and an unstubbable network call is
// an unrunnable test.
export async function classify(cmd, { mode = 'test', cassette, fetchImpl = fetch } = {}) {
  if (mode === 'replay') {
    const store = readCassette(cassette);
    const hit = store.entries[cassetteKey(cmd)];
    if (!hit) throw new Error(`replay: no cassette entry for "${cmd.slice(0, 60)}"`);
    return { answer: hit.answer, model: hit.model, latencyMs: hit.latencyMs, usage: hit.usage, replayed: true };
  }
  if (mode === 'test') {
    const stub = CLASSES.map((c) => (c === 'behavioural' ? 0.5 : 0.5));
    return {
      answer: { choice: 'behavioural', confidence: 0, probabilities: { behavioural: stub[0], loose: stub[1] } },
      model: 'stub',
      latencyMs: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      replayed: false,
    };
  }
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('E_PRECOND_APIKEY: TYPESAFE_API_KEY is not set');

  const started = performance.now();
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildRequest(cmd)),
  });
  if (!res.ok) {
    const retryAfter = res.headers.get('retry-after');
    throw new Error(`jev: HTTP ${res.status}${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
  }
  const body = await res.json();
  const latencyMs = Math.round(performance.now() - started);
  const answer = body.answers?.classification ?? Object.values(body.answers || {})[0];
  if (mode === 'record') {
    const store = readCassette(cassette);
    store.entries[cassetteKey(cmd)] = { cmd, answer, model: body.model, latencyMs, usage: body.usage };
    writeCassette(cassette, store);
  }
  return { answer, model: body.model, latencyMs, usage: body.usage || {}, replayed: false };
}

export function scanCassette(file) {
  // A cassette holds raw model responses to this repository's own plan
  // commands, so it should hold no secret. Assert that rather than assume it.
  const raw = fs.readFileSync(file, 'utf8');
  const patterns = [/apikey_[A-Za-z0-9_]+/g, /Bearer\s+[A-Za-z0-9._-]{16,}/g, /\b[A-Fa-f0-9]{40,}\b/g];
  const hits = patterns.flatMap((re) => (raw.match(re) || []).map((s) => s.slice(0, 12)));
  return { clean: hits.length === 0, hits: [...new Set(hits)] };
}

export const SPIKE_OUT = path.join(ROOT, 'spike-out');
export const CASSETTE_FILE = path.join(SPIKE_OUT, 'jev-cassette.json');
