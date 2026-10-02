#!/usr/bin/env bun
// scripts/vault-index-resolve-chunk.mjs — turn a batch subagent's draft chunk
// into a final chunk whose every path is the exact path from batches.json.
//
// Why this exists, measured on 2026-10-03:
//
//   A subagent transcribing a ~100-char transcript path by hand gets it wrong.
//   On rem-250, 19 of 46 `source_file` values were retyped rather than copied,
//   so they did not resolve on disk, and `check-anchors.mjs` SKIPPED those
//   nodes' anchors without counting them as failures — it printed
//   `ok ... 27 parsed 27 checked 0 failed` and exited 0 while 19 nodes were
//   never tested. The blind spot is silent in exactly the direction that
//   matters. rem-248/249/251 avoided it by writing each path as a basename
//   placeholder and resolving once; all three landed with 0 out-of-batch paths
//   and 0 unresolved basenames on the first attempt.
//
// So a draft chunk may name each file by its basename (`source_file`) and each
// rationale anchor by `[@SELFFILE@:L<n>]`, and this script substitutes the one
// exact path from the batch manifest. The anchor path and `source_file` become
// structurally identical, so they cannot disagree.
//
// Usage:
//   bun scripts/vault-index-resolve-chunk.mjs rem-202 [--draft PATH] [--out PATH]
//
// Default draft: /tmp/opencode/vault-chunks/.draft-<ID>.json
// Default out:   vault-index/semantic/chunk-<ID>.json
//
// Exit 0 = chunk written, every path resolved within the batch.
// Exit 1 = nothing written; errors printed. The parent re-dispatches the batch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAnchors } from './check-anchors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BATCHES = path.join(REPO, 'vault-index/semantic/batches.json');
const DEFAULT_DIR = '/tmp/opencode/vault-chunks';

/** Basename of a path, tolerating both separators. */
function base(p) {
  return p.split(/[\\/]/).pop();
}

/**
 * Resolve a draft chunk against one batch's file list.
 *
 * Pure: no filesystem, so the test can exercise it without a real vault. Every
 * path in the result is copied verbatim from `filePaths`; nothing is typed.
 *
 * A `source_file` or anchor path may be given as:
 *   - `@SELFFILE@`         the node's own resolved source_file
 *   - a basename           e.g. `2026-09-26 - foo [ses_x].md`
 *   - the exact full path  (idempotent; already-resolved chunks pass through)
 *
 * @param {{nodes?: unknown[], links?: unknown[]}} draft
 * @param {string[]} filePaths exact repo-relative paths of the batch
 * @returns {{chunk: object, errors: string[], resolved: number, nodes: number}}
 */
export function resolveChunk(draft, filePaths) {
  const errors = [];
  const full = new Set(filePaths);
  const byBase = new Map();
  for (const p of filePaths) {
    const b = base(p);
    if (byBase.has(b)) {
      errors.push(`duplicate basename in batch: ${JSON.stringify(b)} (${byBase.get(b)} vs ${p})`);
    } else {
      byBase.set(b, p);
    }
  }

  const locate = (raw, ctx, ownRel) => {
    if (raw === '@SELFFILE@') {
      if (!ownRel) { errors.push(`${ctx}: @SELFFILE@ used but source_file did not resolve`); return null; }
      return ownRel;
    }
    if (full.has(raw)) return raw;
    if (byBase.has(raw)) return byBase.get(raw);
    if (byBase.has(raw + '.md')) return byBase.get(raw + '.md');
    errors.push(`${ctx}: path ${JSON.stringify(raw)} is not in this batch`);
    return null;
  };

  const rawNodes = Array.isArray(draft?.nodes) ? draft.nodes : null;
  if (!rawNodes) {
    return { chunk: draft, errors: [...errors, 'draft.nodes is not an array'], resolved: 0, nodes: 0 };
  }

  let resolved = 0;
  const nodes = rawNodes.map((n, i) => {
    const ctx = `nodes[${i}] (${n && n.id ? n.id : 'no-id'})`;
    const ownRel = n && typeof n.source_file === 'string' ? locate(n.source_file, ctx, null) : null;
    if (ownRel) resolved += 1;
    const node = { ...n, source_file: ownRel ?? n.source_file };

    const rewrite = (s) => {
      if (typeof s !== 'string') return s;
      let out = s;
      // Reverse order so earlier anchor offsets stay valid as we splice.
      const anchors = parseAnchors(s);
      for (let k = anchors.length - 1; k >= 0; k--) {
        const a = anchors[k];
        const target = locate(a.file, `${ctx} anchor`, ownRel);
        if (!target) continue;
        out = out.slice(0, a.start + 1) + target + out.slice(a.start + 1 + a.file.length);
      }
      return out;
    };

    if (typeof n.rationale === 'string') node.rationale = rewrite(n.rationale);
    else if (Array.isArray(n.rationale)) node.rationale = n.rationale.map(rewrite);
    return node;
  });

  return { chunk: { ...draft, nodes }, errors, resolved, nodes: nodes.length };
}

function main() {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => !a.startsWith('--') && !a.startsWith('/'));
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  if (!id) {
    console.error('usage: vault-index-resolve-chunk.mjs <batch-id> [--draft PATH] [--out PATH]');
    process.exit(2);
  }

  const batches = JSON.parse(fs.readFileSync(BATCHES, 'utf8'));
  const entry = (batches.batches ?? []).find((b) => b.id === id);
  if (!entry) {
    console.error(`unknown batch ${id} in ${BATCHES}`);
    process.exit(1);
  }
  const filePaths = (entry.files ?? []).map((f) => f.path);

  const draftPath = opt('--draft') ?? path.join(DEFAULT_DIR, `.draft-${id}.json`);
  const outPath = opt('--out') ?? path.join(REPO, 'vault-index/semantic', `chunk-${id}.json`);
  if (!fs.existsSync(draftPath)) {
    console.error(`draft not found: ${draftPath}`);
    process.exit(1);
  }
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  const { chunk, errors, resolved, nodes } = resolveChunk(draft, filePaths);

  if (errors.length > 0) {
    console.error(`FAIL ${id}: ${errors.length} path error(s), nothing written`);
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }

  // Preserve provenance without letting a stray `batch` array surprise later readers.
  if (chunk.batch === undefined) chunk.batch = id;
  fs.writeFileSync(outPath, JSON.stringify(chunk, null, 2) + '\n', 'utf8');
  console.log(`ok ${id}: ${nodes} nodes, ${resolved} source_file resolved, ${(chunk.links ?? []).length} links -> ${path.relative(REPO, outPath)}`);
  process.exit(0);
}

if (import.meta.main) main();
