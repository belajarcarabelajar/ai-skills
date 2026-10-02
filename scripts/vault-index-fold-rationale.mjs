#!/usr/bin/env bun
/**
 * Fold `rationale_for` edges into a `rationale` attribute on their target node.
 *
 * ## Why
 *
 * graphify's own extraction prompt says: store a rationale as an attribute on
 * the relevant concept node and "do NOT create a separate rationale node or
 * fragment node". Our contract used to say the opposite — emit a rationale
 * node plus a `rationale_for` edge — and 88 chunks were written that way before
 * the contract was corrected on 2026-10-02.
 *
 * Discarding them would throw away 771 claims that were each verified against
 * a line in a real file. This script folds them instead, losslessly.
 *
 * ## Lossless, not lossy
 *
 * The rationale's own `source_file` and `source_location` are preserved inside
 * the attribute value as `[anchor] text`, because the whole point of this
 * project is that every claim can be traced to a line. A fold that kept only
 * the prose would silently destroy 771 anchors.
 *
 * ## What it refuses to do
 *
 * - It never drops a node. A rationale node with no resolvable
 *   `rationale_for` target is left in place and reported, not deleted --
 *   silently discarding it is the failure mode this project keeps fighting.
 * - It never merges two rationales into one by concatenating them into a
 *   sentence. Multiple rationales for one concept become an array, so nothing
 *   is paraphrased away.
 * - It never rewrites anything outside the chunk it was given.
 *
 * Usage:
 *   bun scripts/vault-index-fold-rationale.mjs <file.json> [...]   # dry run, prints a plan
 *   bun scripts/vault-index-fold-rationale.mjs --write <file.json> [...]
 */

import { readFileSync, writeFileSync } from 'node:fs';

const ANCHOR_PREFIX = /^\s*\[/;

/**
 * @typedef {{ rationale?: unknown, label?: unknown, source_file?: unknown,
 *   source_location?: unknown }} Node
 * @typedef {{ relation?: unknown, source?: unknown, target?: unknown }} Link
 */

/**
 * Render a rationale node as an attributable string: the reason, then where it
 * was said. Returns null when the node carries no usable text, because an
 * attribute with no text is worse than an honest gap.
 *
 * @param {Node} node
 * @returns {string | null}
 */
export function renderRationale(node) {
  const text = [node.rationale, node.label, node.summary, node.description]
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim())
    .find((v) => !ANCHOR_PREFIX.test(v));
  if (!text) return null;
  const file = typeof node.source_file === 'string' ? node.source_file : '';
  const line = typeof node.source_location === 'string' ? node.source_location : '';
  if (file && line) return `[${file}:${line}] ${text}`;
  if (file) return `[${file}] ${text}`;
  if (line) return `[${line}] ${text}`;
  return text;
}

/**
 * Fold one chunk.
 *
 * @param {{nodes?: Node[], links?: Link[]}} chunk
 * @returns {{chunk: object, folded: number, unattached: string[], alreadyAttribute: number}}
 */
export function foldChunk(chunk) {
  const nodes = Array.isArray(chunk.nodes) ? chunk.nodes : [];
  const links = Array.isArray(chunk.links) ? chunk.links : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // rationale source id -> [targets it explains]
  /** @type {Map<string, string[]>} */
  const explains = new Map();
  for (const l of links) {
    if (l?.relation !== 'rationale_for') continue;
    if (typeof l.source !== 'string' || typeof l.target !== 'string') continue;
    if (!explains.has(l.source)) explains.set(l.source, []);
    explains.get(l.source).push(l.target);
  }

  let folded = 0;
  let alreadyAttribute = 0;
  /** @type {string[]} */
  const unattached = [];
  /** @type {Set<string>} */
  const consumed = new Set();

  for (const [rationaleId, targets] of explains) {
    const rationaleNode = byId.get(rationaleId);
    if (!rationaleNode) continue;
    const rendered = renderRationale(rationaleNode);
    if (!rendered) {
      unattached.push(rationaleId);
      continue;
    }
    for (const targetId of targets) {
      const target = byId.get(targetId);
      if (!target) {
        unattached.push(rationaleId);
        continue;
      }
      const existing = target.rationale;
      if (existing === undefined) target.rationale = rendered;
      else if (Array.isArray(existing)) existing.push(rendered);
      else target.rationale = [existing, rendered];
      consumed.add(rationaleId);
      folded += 1;
    }
  }

  // A rationale node carrying no rationale_for edge at all would otherwise pass
  // through in silence. `explains` is built from links, so a node absent from
  // it never reaches the loop above and never lands in `unattached` -- which is
  // exactly the "771 nodes, some unexplained" case a reader most needs to see.
  for (const n of nodes) {
    if (n?.file_type === 'rationale' && !explains.has(n.id) && !consumed.has(n.id)) {
      unattached.push(n.id);
    }
  }

  // Only remove a rationale node when it was actually folded somewhere. A node
  // with no edge, or an unrenderable one, stays and is reported.
  const keptNodes = nodes.filter((n) => !consumed.has(n.id));

  // Drop a rationale_for edge exactly when its source node was folded away,
  // so no edge outlives the node it named. An edge whose source was never in
  // `nodes` to begin with is a pre-existing extractor defect, not something
  // this fold caused: it is left untouched and counted in `danglingEdges` so
  // the caller sees it rather than inheriting it silently.
  const keptLinks = links.filter(
    (l) => l?.relation !== 'rationale_for' || !consumed.has(l.source),
  );
  const danglingEdges = links.filter(
    (l) =>
      l?.relation === 'rationale_for' &&
      typeof l.source === 'string' &&
      !byId.has(l.source),
  );

  alreadyAttribute = nodes.filter(
    (n) => typeof n.rationale === 'string' || Array.isArray(n.rationale),
  ).length;

  return {
    chunk: { ...chunk, nodes: keptNodes, links: keptLinks },
    folded,
    unattached: [...new Set(unattached)],
    alreadyAttribute,
    danglingEdges: danglingEdges.map((l) => l.source),
  };
}

function main(argv) {
  const write = argv.includes('--write');
  const files = argv.filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('usage: vault-index-fold-rationale.mjs [--write] <chunk.json> [...]');
    return 2;
  }
  let totalFolded = 0;
  let allUnattached = [];
  for (const file of files) {
    const chunk = JSON.parse(readFileSync(file, 'utf8'));
    const before = chunk.nodes.length;
    const { chunk: out, folded, unattached } = foldChunk(chunk);
    totalFolded += folded;
    allUnattached.push(...unattached);
    console.log(
      `${file}: ${folded} folded, ${before} -> ${out.nodes.length} nodes, ` +
        `${chunk.links.length} -> ${out.links.length} links` +
        (unattached.length ? `, ${unattached.length} UNATTACHED` : ''),
    );
    if (write) writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  }
  console.log(`total folded: ${totalFolded}`);
  if (allUnattached.length) {
    console.log(`\nUNATTACHED rationale nodes (left in place, not deleted):`);
    for (const id of allUnattached) console.log(`  ${id}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}