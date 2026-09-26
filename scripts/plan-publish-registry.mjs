#!/usr/bin/env bun
// scripts/plan-publish-registry.mjs
//
// Routing table for plan publishing: which project owns a plan file, and where
// inside the Obsidian vault that plan's read-only copy belongs.
//
// Why this is separate from the publisher: routing is the one step that cannot
// be inferred from the plan itself. A plan file carries no project name, so the
// only evidence is its absolute path. Getting it wrong does not crash — it
// quietly files a plan under the wrong vault project, where a human finds it
// weeks later and cannot tell whether it was a routing bug or a stale mirror.
// Hence this module is pure, total, and refuses to guess: an unroutable plan
// is an error, never a default.
//
//   bun scripts/plan-publish.mjs <plan.md>   uses this module
//   bun test scripts/plan-publish-registry.test.mjs
//
// The `vault` project entry carries `mirror: false` on purpose. Its plans are
// already inside the vault, so publishing them would copy a file onto itself.
// That flag is the only thing preventing the self-copy, so enumeratePlans()
// excludes those roots rather than filtering them at write time.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = path.join(rootDir, 'plans.publish.json');

// Where a project keeps its plans, relative to the project root.
const PLANS_SUBDIR = path.join('docs', 'code-plan', 'plans');

// ---------- Config loading ----------

export function loadRegistry(configPath = DEFAULT_CONFIG) {
  if (!existsSync(configPath)) throw new Error(`missing plan publish config: ${configPath}`);

  let registry;
  try {
    registry = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`cannot parse plan publish config ${configPath}: ${e.message}`);
  }
  if (!registry || typeof registry !== 'object') {
    throw new Error(`plan publish config ${configPath} is not a JSON object`);
  }

  for (const field of ['vault', 'destDirTemplate', 'projects']) {
    if (!registry[field]) throw new Error(`plan publish config ${configPath} is missing "${field}"`);
  }
  if (!Array.isArray(registry.projects)) {
    throw new Error(`plan publish config ${configPath}: "projects" must be an array`);
  }

  const seenNames = new Set();
  const seenRoots = new Set();
  for (const p of registry.projects) {
    if (!p || !p.name || !p.root) {
      throw new Error(`plan publish config ${configPath}: every project needs a "name" and a "root"`);
    }
    if (seenNames.has(p.name)) {
      throw new Error(`plan publish config ${configPath}: duplicate project name "${p.name}"`);
    }
    if (seenRoots.has(p.root)) {
      throw new Error(`plan publish config ${configPath}: duplicate project root "${p.root}"`);
    }
    seenNames.add(p.name);
    seenRoots.add(p.root);
  }

  return registry;
}

// ---------- Routing ----------

// A root owns a plan when the plan lives strictly below it. Comparing resolved
// path segments is what keeps /proj/snip from claiming /proj/snipset-2.
function owns(root, planPath) {
  const rel = path.relative(path.resolve(root), path.resolve(planPath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

export function resolveProject(registry, planPath) {
  // Longest root wins, so a project nested inside another project resolves to
  // the inner one instead of the outer.
  let best = null;
  for (const p of registry.projects) {
    if (!owns(p.root, planPath)) continue;
    if (!best || p.root.length > best.root.length) best = p;
  }
  if (!best) {
    throw new Error(
      `no project in plans.publish.json owns "${planPath}". `
      + 'Add its root to plans.publish.json, or pass a path under a registered project.',
    );
  }
  return best;
}

export function enumeratePlans(registry) {
  const out = [];
  for (const p of registry.projects) {
    // mirror:false is the vault's own entry; publishing it would copy a file
    // onto itself, so it is never a source.
    if (p.mirror === false) continue;
    const dir = path.join(p.root, PLANS_SUBDIR);
    // A project that has never written a plan is not an error; there is simply
    // nothing to mirror yet.
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      out.push(path.join(dir, entry.name));
    }
  }
  return out.sort();
}

// ---------- Destination ----------

export function destPathFor(registry, project, planPath) {
  // node:path throughout: the vault path contains a space ("Obsidian Vault"),
  // and hand-rolled string joins are how that kind of name gets broken.
  const relDir = registry.destDirTemplate.replaceAll('{project}', project.name);
  return path.join(registry.vault, relDir, path.basename(planPath));
}
