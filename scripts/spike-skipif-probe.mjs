#!/usr/bin/env node
// Spike T4 — the two-class probe.
//
// 200 real commands, each labelled by the frozen `classifySpikeSkipIf`, each
// also classified by Jev. The output is agreement, calibration, latency, and a
// recomputed cost figure — plus the full disagreement list, because the gate in
// the plan turns on whether any disagreement is a case where the regex is wrong.
//
// The reference label comes from `./spike-skipif-classifier.mjs`, a frozen
// snapshot, NOT from the live `classifySkipIf` in `./ultra-plan-runner.mjs`.
// The live function is changing — `sentinel`, `unknown`, and a widened
// `FILE_PROBE` are all coming — and each of those changes invalidates rows of
// the committed corpus. Pointing this probe at the live function would not
// measure a different system; it would stop this report from being about the
// system it is published as being about.
//
// Requests are serialised. Two hundred concurrent calls would measure the queue
// and the rate limiter, not the model, and the latency figure is one of the
// numbers this spike exists to produce.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, deriveVerdict, CASSETTE_FILE, scanCassette } from './spike-jev-client.mjs';
import { expectedCalibrationError, brierScore, accuracy, confusion } from './spike-calibration.mjs';
import { classifySpikeSkipIf } from './spike-skipif-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Published price, used to recompute what the run cost. It is a vendor figure,
// so it is reported next to the token counts it was applied to rather than in
// place of them: if the price changed, the token counts still tell the truth.
export const PRICE_PER_MTOK = 0.042;

// Fixed in the plan before the probe ran. Do not tune these against a result.
export const GATE = { minAgreement: 0.85, maxEce: 0.10, minTotal: 150, failAgreement: 0.75, failEce: 0.20 };

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(corpus, results, { latency = [], retried = 0 } = {}) {
  const byId = new Map(corpus.map((r) => [r.id, r]));
  const pairs = [];
  const rows = [];
  const disagreements = [];

  for (const res of results) {
    const row = byId.get(res.id);
    if (!row) {
      throw new Error(`summarize: result ${res.id} has no corpus row; a dropped row would silently inflate agreement`);
    }
    if (row.label !== classifySpikeSkipIf(row.cmd)) {
      throw new Error(`summarize: corpus label for ${res.id} is stale relative to classifySpikeSkipIf`);
    }
    const v = res.verdict;
    pairs.push({ p: v.p, correct: v.correct });
    rows.push({ ...row, predicted: v.predicted, correct: v.correct, p: v.p, confidence: v.confidence });
    if (!v.correct) {
      disagreements.push({
        id: res.id,
        cmd: row.cmd,
        project: row.project,
        source: row.source,
        reference: row.label,
        predicted: v.predicted,
        p: v.p,
        confidence: v.confidence,
      });
    }
  }

  const agree = results.filter((r) => r.verdict.correct).length;
  const apiTokens = results.reduce((sum, r) => sum + (r.usage?.input_tokens || 0), 0);
  return {
    total: results.length,
    agree,
    agreement: results.length ? agree / results.length : 0,
    accuracy: accuracy(pairs),
    ece: expectedCalibrationError(pairs),
    brier: brierScore(pairs),
    confusion: confusion(rows.map((r) => ({ label: r.label, predicted: r.predicted }))),
    disagreements,
    latency: {
      meanMs: latency.length ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length) : null,
      p50Ms: percentile(latency, 50),
      p95Ms: percentile(latency, 95),
      maxMs: latency.length ? Math.max(...latency) : null,
    },
    cost: {
      pricePerMtokUsd: PRICE_PER_MTOK,
      basis: 'vendor published price applied to the API-reported input tokens',
      apiReportedInputTokens: apiTokens,
      recomputedUsd: (apiTokens / 1_000_000) * PRICE_PER_MTOK,
    },
    retries: retried,
    rows,
  };
}

// The gate, verbatim from the plan §5. Condition 3 is the one that matters:
// agreement alone only proves the model can imitate a correct rule, which is not
// a reason to add a network call to a hot path.
export function verdictFor({ total, agreement, ece, regexWrongCases = 0 }) {
  if (total < GATE.minTotal) {
    return { verdict: 'insufficient evidence', reason: `sample of ${total} is below the ${GATE.minTotal} floor; no rate here is stable enough to rule on` };
  }
  if (agreement < GATE.failAgreement) {
    return { verdict: 'gate fails', reason: `agreement ${agreement.toFixed(3)} is below the ${GATE.failAgreement} fail line` };
  }
  if (ece > GATE.failEce) {
    return { verdict: 'gate fails', reason: `ECE ${ece.toFixed(3)} exceeds the ${GATE.failEce} fail line; the model's stated confidence does not track its accuracy` };
  }
  if (regexWrongCases === 0) {
    return { verdict: 'gate fails', reason: 'agreement is high but no disagreement was adjudicated as the regex being wrong, so nothing here justifies a network call the repo does not already make in-process' };
  }
  const passes = agreement >= GATE.minAgreement && ece <= GATE.maxEce;
  return {
    verdict: passes ? 'gate passes' : 'insufficient evidence',
    reason: passes
      ? `agreement ${agreement.toFixed(3)}, ECE ${ece.toFixed(3)}, and ${regexWrongCases} case(s) where the regex is wrong`
      : `agreement ${agreement.toFixed(3)} and ECE ${ece.toFixed(3)} sit between the pass and fail lines`,
  };
}

export async function runProbe({ corpus, mode, out, cassette = CASSETTE_FILE }) {
  const results = [];
  const latency = [];
  let retried = 0;
  let model = null;

  for (const row of corpus) {
    const attempts = mode === 'record' ? 3 : 1;
    let lastErr;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await classify(row.cmd, { mode, cassette });
        model = res.model || model;
        latency.push(res.latencyMs);
        results.push({ id: row.id, verdict: deriveVerdict(res.answer, row.label), usage: res.usage });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < attempts - 1) {
          retried++;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    if (lastErr) throw new Error(`probe failed on ${row.cmd.slice(0, 70)}: ${lastErr.message}`);
    if (mode === 'record' && (results.length % 25 === 0)) {
      process.stderr.write(`  ${results.length}/${corpus.length}\n`);
    }
  }

  // The reference label is the frozen function of the freeze date, so the
  // corpus's stored label is only a cache. Re-derive it here so a stale corpus
  // cannot quietly skew the agreement number.
  const reference = corpus.map((r) => ({ ...r, label: classifySpikeSkipIf(r.cmd) }));

  const summarizeOut = summarize(reference, results, { latency, retried });
  const verdict = verdictFor({
    total: summarizeOut.total,
    agreement: summarizeOut.agreement,
    ece: summarizeOut.ece,
    regexWrongCases: 0, // set from the adjudication in T5
  });
  return { model, summarize: { ...summarizeOut, verdict } };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i === -1 ? fallback : path.resolve(ROOT, args[i + 1]);
  };
  const corpusFile = get('--corpus', path.join(ROOT, 'spike-out', 'corpus.json'));
  const out = get('--out', path.join(ROOT, 'spike-out', 'two-class.json'));
  const mode = args.includes('--replay') ? 'replay' : args.includes('--live') ? 'live' : 'record';

  const corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
  const run = await runProbe({ corpus, mode, out });
  const scan = scanCassette(CASSETTE_FILE);

  const payload = {
    probe: 'jev-skipif-two-class',
    recordedAt: new Date().toISOString(),
    mode,
    model: run.model,
    priceNote: 'Jev pricing is a vendor claim; cost here is that price applied to measured tokens',
    cassetteClean: scan,
    ...run.summarize,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);

  const s = run.summarize;
  console.log(`model           ${run.model}`);
  console.log(`sample          ${s.total} commands`);
  console.log(`agreement       ${s.agreement.toFixed(3)}  (${s.agree}/${s.total})`);
  console.log(`ECE             ${s.ece.toFixed(3)}`);
  console.log(`Brier           ${s.brier.toFixed(3)}`);
  console.log(`latency ms      mean ${s.latency.meanMs}  p50 ${s.latency.p50Ms}  p95 ${s.latency.p95Ms}  max ${s.latency.maxMs}`);
  console.log(`cost USD        ${s.cost.recomputedUsd.toFixed(6)}  (${s.cost.apiReportedInputTokens} input tokens)`);
  console.log(`retries         ${s.retries}`);
  console.log(`disagreements   ${s.disagreements.length}  -> listed for adjudication in T5`);
  console.log(`cassette scan   ${scan.clean ? 'clean' : `DIRTY ${scan.hits.join(',')}`}`);
  console.log(`pre-verdict     ${s.verdict.verdict} (${s.verdict.reason})`);
}
