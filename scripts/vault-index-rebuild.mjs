#!/usr/bin/env bun
// scripts/vault-index-rebuild.mjs — T9: assemble the vault graph and write it.
//
// THE PROBLEM THIS RUNNER EXISTS FOR.
//
// T9 merges three layers — the graph that already exists in the vault, the
// deterministic structural layer, and the subagent-emitted semantic chunks —
// and writes the result back over `graphify-out/graph.json`. T4's `merge()`
// does the union; this file does the assembling, and the assembling is where
// the one measured defect lived.
//
// MEASURED 2026-10-03: the naive assembly RAISED degree-0 from 1,415 to 1,790,
// which fails T9's own step-3 gate ("degree-0 strictly lower than the old
// 1,415"). The cause was not the merge — it was that the old graph and the
// structural layer name the same note differently. The structural layer slugs
// a document id from its repo-relative path; the old graph's document ids are
// almost the same string but not always identical, because some carry a
// graphify-era suffix (`..._migration_document` where structural emits
// `..._migration`) and some preserve dashes (`03_-_Resources_...` where
// structural emits `03_resources_...`). So a re-emitted document did not
// collide with the old one, its `contains` edges attached to a brand-new node,
// and the old node stayed an orphan. 1,369 of the old 1,415 never re-attached.
//
// THE FIX, AND WHY IT IS SAFE: A DOCUMENT'S IDENTITY IS ITS FILE.
//
// Before merging, every OLD node whose `file_type` is `document` and whose
// `source_file` names a file the structural layer re-emits is remapped onto the
// structural layer's id for that file; the old graph's links are rewritten to
// follow. Nothing is invented: the target id is copied from the structural
// node that cited the same path, and the mapping is keyed on the path itself.
// The union then collapses the two records, and the freshly-emitted `contains`
// edges land on the one surviving node.
//
// ONLY `document` NODES ARE REMAPPED, and that restriction is the whole
// safety argument. A `concept` or `code` node's identity is its CLAIM, not its
// path — two different claims can legitimately cite the same file — so mapping
// them by `source_file` would fuse distinct nodes into one. Measured: a
// path-keyed map over every file_type would "reconnect" 1,291 orphans, but 814
// of those are concept/code/rationale nodes it would have merged incorrectly.
// Restricting to documents reconnects 477 and is the only mapping where path
// equality is the same proposition as node identity. The gate clears on the
// smaller, correct number (projected degree-0 1,313 < 1,415).
//
// Usage:
//   bun scripts/vault-index-rebuild.mjs             # dry run, writes nothing
//   bun scripts/vault-index-rebuild.mjs --write     # back up, then write graph.json
//
// The dry run is the default on purpose: the thing being overwritten is the
// vault's only record of 6,155 nodes of accumulated work.

import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan } from './vault-index.mjs';
import { structural } from './vault-index-structural.mjs';
import { loadChunks, merge, writeGraph } from './vault-index-merge.mjs';

/** The two corpus roots. Transcripts moved out of the vault on 2026-10-02. */
export const VAULT_ROOT = '/home/belajarcarabelajar/Dokumen/Obsidian Vault';
export const ARCHIVE_ROOT = '/home/belajarcarabelajar/Documents/conversations-archive';

/** A non-empty string, or null. */
function filled(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Fill absent fields of `target` from `incoming`; first real value wins. */
function mergeFields(target, incoming) {
  for (const key of Object.keys(incoming)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const cur = target[key];
    if ((cur === undefined || cur === null || cur === '') && incoming[key] !== undefined) {
      target[key] = incoming[key];
    }
  }
}

/**
 * The structural document id for every source_file the layer re-emits.
 *
 * Read off the structural chunks rather than recomputed with `slugFor`, because
 * a colliding pair of document ids gets a disambiguation hash appended during
 * `structural()` and only the emitted chunk carries the final value.
 *
 * @param {Array<{chunk?: {nodes?: object[]}}>} structuralChunks
 * @returns {Map<string, string>} source_file -> document id (first wins)
 */
export function buildIdBySourceFile(structuralChunks) {
  const bySourceFile = new Map();
  for (const entry of structuralChunks ?? []) {
    for (const node of entry?.chunk?.nodes ?? []) {
      if (node?.file_type !== 'document') continue;
      const sourceFile = filled(node.source_file);
      if (sourceFile === null || !filled(node.id)) continue;
      if (!bySourceFile.has(sourceFile)) bySourceFile.set(sourceFile, node.id);
    }
  }
  return bySourceFile;
}

/**
 * Remap the old graph's document ids onto the structural layer's ids.
 *
 * Pure: returns a new `previous`; the input is not mutated. When no document id
 * changes, the original object is returned untouched so a caller can cheaply
 * tell the pass was a no-op.
 *
 * @param {{nodes?: object[], links?: object[], [k: string]: unknown}} previous
 * @param {Map<string, string>} idBySourceFile
 * @returns {{previous: object, report: object}}
 */
export function normalizePreviousIds(previous, idBySourceFile) {
  const report = {
    documentIdsRemapped: 0,
    nodesCollapsed: 0,
    linksRewritten: 0,
    selfLoopsDropped: 0,
    linksDeduplicated: 0,
  };
  const nodes = Array.isArray(previous?.nodes) ? previous.nodes : null;
  if (nodes === null || idBySourceFile.size === 0) return { previous, report };

  const idMap = new Map();
  for (const node of nodes) {
    if (node === null || typeof node !== 'object' || node.file_type !== 'document') continue;
    const sourceFile = filled(node.source_file);
    if (sourceFile === null) continue;
    const target = idBySourceFile.get(sourceFile);
    if (target !== undefined && target !== node.id) idMap.set(node.id, target);
  }
  if (idMap.size === 0) return { previous, report };

  const byId = new Map();
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue;
    const id = idMap.get(node.id) ?? node.id;
    const existing = byId.get(id);
    if (existing !== undefined) {
      report.nodesCollapsed += 1;
      mergeFields(existing, node);
    } else {
      byId.set(id, { ...node, id });
    }
  }
  report.documentIdsRemapped = idMap.size;

  const seen = new Set();
  const links = [];
  for (const link of previous.links ?? []) {
    if (link === null || typeof link !== 'object') continue;
    const source = idMap.get(link.source) ?? link.source;
    const target = idMap.get(link.target) ?? link.target;
    // Two nodes fused into one turns an old edge between them into a self-loop.
    if (source === target) {
      report.selfLoopsDropped += 1;
      continue;
    }
    if (source !== link.source || target !== link.target) report.linksRewritten += 1;
    const key = [source, target, String(link.relation)].join('\u0000');
    if (seen.has(key)) {
      report.linksDeduplicated += 1;
      continue;
    }
    seen.add(key);
    links.push({ ...link, source, target });
  }

  return { previous: { ...previous, nodes: [...byId.values()], links }, report };
}

/** Count nodes that are not an endpoint of any link. */
export function degreeZero(graph) {
  const connected = new Set();
  for (const link of graph?.links ?? []) {
    if (link === null || typeof link !== 'object') continue;
    connected.add(link.source);
    connected.add(link.target);
  }
  return (graph?.nodes ?? []).filter((n) => !connected.has(n.id)).length;
}

/** The vault's current HEAD, or null when it cannot be read. */
export function vaultHead(root = VAULT_ROOT) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Assemble the merged graph in memory. No filesystem writes.
 *
 * @param {{vaultRoot?: string, archiveRoot?: string, semanticDir: string,
 *   previous: object, builtAtCommit?: string|null}} opts
 * @returns {{graph: object, report: object, normalization: object, semReport: object}}
 */
export function assemble({ vaultRoot = VAULT_ROOT, archiveRoot = ARCHIVE_ROOT, semanticDir, previous, builtAtCommit = null }) {
  const roots = [archiveRoot, vaultRoot];
  const structuralChunks = [];
  for (const root of roots) {
    const s = scan(root);
    const { chunk } = structural(root, s.eligible, { knownPaths: s.eligible });
    structuralChunks.push({ name: `structural:${root}`, chunk });
  }

  const idBySourceFile = buildIdBySourceFile(structuralChunks);
  const { previous: normalized, report: normalization } = normalizePreviousIds(previous, idBySourceFile);

  const { chunks: semantic, report: semReport } = loadChunks(semanticDir, { roots });
  const { graph, report } = merge([...structuralChunks, ...semantic], {
    previous: normalized,
    builtAtCommit,
    ghostPolicy: 'reattribute',
  });

  return { graph, report, normalization, semReport };
}

/**
 * T9 step 3, as a function: node count not smaller, degree-0 strictly lower.
 *
 * @param {object} graph
 * @param {{nodes?: object[], links?: object[]}} previous
 */
export function gateVerdict(graph, previous) {
  const nodesBefore = (previous?.nodes ?? []).length;
  const mergedNodes = (graph?.nodes ?? []).length;
  const d0Before = degreeZero(previous);
  const d0After = degreeZero(graph);
  const pass = mergedNodes >= nodesBefore && d0After < d0Before;
  return { pass, nodesBefore, mergedNodes, d0Before, d0After };
}

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const semanticDir = resolvePath(fileURLToPath(new URL('../vault-index/semantic', import.meta.url)));
  const graphPath = resolvePath(VAULT_ROOT, 'graphify-out/graph.json');
  const reportPath = resolvePath(VAULT_ROOT, 'graphify-out/GRAPH_REPORT.md');

  if (!existsSync(graphPath)) {
    console.error(`no existing graph at ${graphPath} — nothing to merge onto`);
    process.exit(2);
  }
  const previous = JSON.parse(readFileSync(graphPath, 'utf8'));

  const { graph, report, normalization, semReport } = assemble({
    semanticDir,
    previous,
    builtAtCommit: vaultHead(),
  });

  console.log('--- structural + semantic assembly ---');
  console.log(`  semantic chunks read:      ${semReport.chunkFilesRead}`);
  console.log(`  semantic nodes dropped:    ${semReport.nodesUnattributable} (unattributable source_file)`);
  console.log(`  old document ids remapped: ${normalization.documentIdsRemapped}`);
  console.log(`  old nodes collapsed:       ${normalization.nodesCollapsed}`);
  console.log(`  old links rewritten:       ${normalization.linksRewritten}`);
  console.log('--- merge report ---');
  for (const key of [
    'chunksAccepted', 'chunksRejected', 'nodes', 'links',
    'previousNodes', 'previousNodesUnusableSourceFile', 'nodeIdCollisions',
    'crossChunkResolved', 'crossChunkDangling', 'danglingLinksDropped',
    'ghostNodes', 'ghostNodesReattributed', 'ambiguousReattribution', 'unmatchedReattribution',
    'nodesRetainedFromPrevious', 'linksRetainedFromPrevious',
  ]) {
    console.log(`  ${key}: ${report[key]}`);
  }
  if (report.rejections?.length) console.log('  rejections:', report.rejections.slice(0, 3));

  const gate = gateVerdict(graph, previous);
  console.log('--- T9 step 3 gate ---');
  console.log(`  nodes:  ${gate.nodesBefore} -> ${gate.mergedNodes}  (must be >=)   ${gate.mergedNodes >= gate.nodesBefore ? 'PASS' : 'FAIL'}`);
  console.log(`  degree-0: ${gate.d0Before} -> ${gate.d0After}  (must be strictly lower)  ${gate.d0After < gate.d0Before ? 'PASS' : 'FAIL'}`);

  if (!gate.pass) {
    console.error('GATE FAILED — nothing written. The vault graph is untouched.');
    process.exit(1);
  }

  if (!write) {
    console.log('DRY RUN — nothing written. Re-run with --write to back up and write.');
    process.exit(0);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const backupDir = resolvePath(VAULT_ROOT, `graphify-out/backup-${stamp}-t9`);
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(graphPath, resolvePath(backupDir, 'graph.json'));
  if (existsSync(reportPath)) copyFileSync(reportPath, resolvePath(backupDir, 'GRAPH_REPORT.md'));
  console.log(`  backup: ${backupDir}`);

  const written = writeGraph(graph, graphPath);
  console.log(`wrote ${written.path} (${written.bytes} bytes, ${graph.nodes.length} nodes, ${graph.links.length} links)`);
}

if (import.meta.main) main();
