#!/usr/bin/env bun
/**
 * Search node ids already emitted by semantic chunks.
 *
 * Extraction subagents need this before inventing an id. Node ids are the
 * graph's primary keys: two chunks claiming the same id union two different
 * claims, and two chunks making the same claim under different ids fragment
 * it. Neither is visible at merge time.
 *
 * Ids carry a `concept--` / `rationale--` prefix, so searching a bare slug
 * like `tgrep-wrapper-false-negatives` misses. This matches on substring
 * against the whole id, and prints the emitting chunk so a subagent can go
 * read that node rather than judging from the label.
 *
 * Usage:
 *   bun scripts/vault-index-ids.mjs tgrep
 *   bun scripts/vault-index-ids.mjs --owner chunk-rem-058   # which file emitted an id
 *   bun scripts/vault-index-ids.mjs                         # list every id
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMANTIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vault-index', 'semantic');

/**
 * Load every node id from every chunk, mapped to the chunks that emitted it.
 * @returns {Map<string, Set<string>>} id -> set of chunk filenames
 */
export function loadIdOwners(semanticDir = SEMANTIC_DIR) {
  /** @type {Map<string, Set<string>>} */
  const byId = new Map();
  let files;
  try {
    files = readdirSync(semanticDir);
  } catch {
    return byId;
  }
  for (const file of files) {
    if (!file.startsWith('chunk-') || !file.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(semanticDir, file), 'utf8'));
    } catch {
      continue; // a malformed chunk must not hide every other id
    }
    for (const node of parsed.nodes ?? []) {
      if (!node || typeof node.id !== 'string') continue;
      if (!byId.has(node.id)) byId.set(node.id, new Set());
      byId.get(node.id).add(file);
    }
  }
  return byId;
}

/**
 * @param {string} query substring to match, case-insensitive
 * @param {Map<string, Set<string>>} byId
 * @returns {[string, string[]][]} matching [id, ownerFiles]
 */
export function searchIds(query, byId) {
  const q = query.toLowerCase();
  return [...byId.entries()]
    .filter(([id]) => id.toLowerCase().includes(q))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, owners]) => [id, [...owners].sort()]);
}

function main(argv) {
  const byId = loadIdOwners();

  const ownerFlag = argv.find((a) => a.startsWith('--owner='));
  if (ownerFlag) {
    const id = ownerFlag.slice('--owner='.length);
    const owners = byId.get(id);
    console.log(
      owners
        ? `${id}  emitted by: ${[...owners].sort().join(', ')}`
        : `${id}  not emitted by any chunk`,
    );
    return 0;
  }

  const query = argv.filter((a) => !a.startsWith('--')).join(' ');
  if (!query) {
    console.log(`${byId.size} distinct ids across all chunks:`);
    for (const id of [...byId.keys()].sort()) console.log(id);
    return 0;
  }

  const hits = searchIds(query, byId);
  if (hits.length === 0) {
    console.log(`no existing id matches ${JSON.stringify(query)}`);
  } else {
    for (const [id, owners] of hits) console.log(`${id}  <- ${owners.join(',')}`);
  }
  console.log(`(${byId.size} distinct ids total)`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}