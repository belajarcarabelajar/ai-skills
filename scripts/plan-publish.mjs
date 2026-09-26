#!/usr/bin/env bun
// scripts/plan-publish.mjs
//
// WHY THIS FILE EXISTS
//
// A plan written under `docs/code-plan/plans/` is invisible to the Obsidian
// vault: it is a markdown file in a project repository, and the vault only
// indexes what is inside the vault. So plans cannot be searched, cannot be
// rendered with Mermaid, and do not show up in Obsidian's graph — while they
// are exactly the documents a user most wants to re-read months later.
//
// This CLI copies each plan into `01 - Projects/<Project>/plans/`, adding the
// vault's PARA frontmatter so the copy behaves like any other vault note. The
// copy is a ONE-WAY, READ-ONLY MIRROR: the project repository is the source of
// truth, the mirror is derived state, and the mirror is never hand-edited. The
// publisher never reads a mirror back as an input, so a stale mirror can rot
// visibly (that is what `--check` is for) but can never corrupt a plan.
//
//   bun scripts/plan-publish.mjs <plan.md>... [--dry-run] [--today YYYY-MM-DD]
//   bun scripts/plan-publish.mjs --check [--all]     exit 1 on drift / missing mirror
//   bun scripts/plan-publish.mjs --status            table, always exit 0
//
// Exit codes: 0 success or idempotent skip · 1 drift, missing mirror, refused
// destination, or transform failure · 2 usage error. `--check` never writes.
// `--dry-run` prints the destination and whether it would write, and neither
// writes nor stages.
//
// PATHS ARE RESOLVED TO ABSOLUTE, ONCE, EARLY
//
// A plan path is made absolute at the top of publishOne()/checkOne() through the
// single `absolute()` seam, and that one value is what gets routed, read, hashed
// and written as `source_path`. So a relative argument is accepted from the
// command line but never leaks into a mirror: `source_path` is the provenance
// field a human follows back to the original plan, and the vault's contract
// test asserts it points at a file on disk, which a relative value cannot
// guarantee from an arbitrary working directory. The vault root is resolved the
// same way, because plans.publish.json is hand-edited and a relative `vault`
// there would silently rebase every related link.
//
// HOW TO REVERT IT
//
// The mirror is fully derived state, so reverting costs nothing but a delete:
//   1. rm -r "<vault>/01 - Projects/<Project>/plans/"   (the mirror itself)
//   2. remove the single Folder Contract bullet that names `plans/` from
//      "<vault>/AGENTS.md"
// That is the whole revert. Nothing is lost: every published plan still exists,
// in full and byte-identical, in its own project repository, which was the
// source of truth the entire time. Do NOT "revert" by restoring mirror files
// from git — that only resurrects copies of files you still have.

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadRegistry, resolveProject, enumeratePlans, destPathFor,
} from './plan-publish-registry.mjs';
import {
  mergeFrontmatter, splitFrontmatter, PUBLISHER_VERSION,
} from './plan-publish-frontmatter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = path.join(rootDir, 'plans.publish.json');

// Vault-denied folders, relative to the vault root. The vault's own rules deny
// them, so the publisher denies them too rather than trusting a config to
// behave. Compared as resolved path SEGMENTS, so a sibling folder that merely
// starts with the same characters (or a plan named "Satset") is unaffected.
const PROTECTED_VAULT_DIRS = ['Satset', '90 - System/Legacy'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USAGE = [
  'usage:',
  '  bun scripts/plan-publish.mjs <plan.md>... [--dry-run] [--today YYYY-MM-DD]',
  '  bun scripts/plan-publish.mjs --check [--all]   # exit 1 on drift or missing mirror',
  '  bun scripts/plan-publish.mjs --status          # table, always exit 0',
].join('\n');

class UsageError extends Error {}

// ---------- small helpers ----------

// Every path that crosses into a mirror is made ABSOLUTE exactly once, through
// this one seam, and the resulting single value is what gets routed, read,
// hashed and written as `source_path`.
//
// Why it has to be absolute, and why it used to be wrong: the CLI was handed
// the plan path verbatim, so `bun scripts/plan-publish.mjs docs/code-plan/…`
// produced `source_path: docs/code-plan/plans/….md`. The plan contract calls
// `source_path` the provenance field a human follows back to the original, and
// the vault's own contract test asserts it points at a file on disk — a
// relative value satisfies neither, because it only means anything relative to
// whichever cwd happened to be current. Resolving independently in the three
// places that each wanted a path is how those three drift apart, so they all
// come through here instead. path.resolve is idempotent, so passing an already
// absolute path back through is a no-op rather than a second opinion.
const absolute = (p) => path.resolve(p);

// The transform hashes the plan TEXT it is given (see plan-publish-frontmatter.mjs,
// `createHash().update(text, 'utf8')`), so the drift comparison must hash the
// same string, not the raw Buffer. For valid UTF-8 the two are identical; for a
// file with invalid bytes they are not, and hashing the Buffer here would make
// every such mirror look permanently drifted.
function hashOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

// FRESHNESS HAS TWO KEYS, NOT ONE
//
// `source_hash` alone is not enough, and that was observed rather than reasoned
// about: `source_hash` is a hash of the PLAN TEXT, so fixing a bug in the
// transform does not move it. After the qualified-link fix, re-running the
// publisher on an UNCHANGED plan printed SKIPPED-IDEMPOTENT, the mirror on disk
// kept the old broken `[[ai-skills index]]`, and `--check --all` reported that
// mirror as OK. A mirror written by a previous publisher could never heal, and
// the drift check actively lied about it.
//
// So a mirror counts as current only when its `source_hash` matches the source
// AND its `publisher_version` equals the PUBLISHER_VERSION this build emits.
// A missing, unparseable, or different version is a mismatch — which is exactly
// the real-vault case, so it heals on the next publish. The version is IMPORTED,
// never written as a literal here: two copies of a version string is how they
// drift apart, and a hardcoded 1 would keep every mirror looking current after
// the real constant moved.

// Reads one scalar out of a mirror's frontmatter, unquoting and validating it.
// Returns null when the file is absent/unreadable, the key is absent, or the
// value does not match `re` — all of which mean "not provably what we need",
// and the only safe response to that is to rewrite.
function readFrontmatterScalar(file, key, re) {
  if (!existsSync(file)) return null;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { frontmatter } = splitFrontmatter(text);
  const m = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(frontmatter);
  if (!m) return null;
  const value = m[1].replace(/^["'](.*)["']$/, '$1').trim();
  return re.test(value) ? value : null;
}

// The mirror's recorded provenance, as far as it can be trusted.
function readMirrorState(file) {
  return {
    hash: readFrontmatterScalar(file, 'source_hash', /^[0-9a-f]{12}$/),
    // A bare integer, matching how the transform emits it. A quoted "1" is
    // unquoted by the reader above, so both spellings compare equal.
    version: readFrontmatterScalar(file, 'publisher_version', /^\d+$/),
  };
}

// The ONE freshness rule, shared by publishOne and checkOne. Sharing the
// predicate is deliberate: two parallel implementations of "is this current?"
// is how the drift check ends up disagreeing with the publisher.
//
// Returns null when the mirror IS current, and a human-readable reason
// otherwise. Callers must therefore test the return value for TRUTH, never
// compare it to null: an absent mirror, an unreadable one, a bad hash, a wrong
// version and a missing version are all stale, and every one of them has to
// reach the caller as a reason string rather than as a silent null.
function stalenessReason(mirror, sourceHash) {
  if (mirror.hash === sourceHash && mirror.version === String(PUBLISHER_VERSION)) return null;
  if (mirror.hash === sourceHash) {
    // The hash agrees, so the SOURCE is unchanged and the only thing wrong is
    // which publisher produced this mirror. Say so precisely: the fix is to
    // re-publish, not to go hunting for an edit to the plan.
    return `publisher_version ${mirror.version ?? '(absent)'} != ${PUBLISHER_VERSION}`
      + ' (source unchanged; re-publish to refresh the mirror)';
  }
  if (mirror.hash === null) return `mirror has no readable source_hash (source is ${sourceHash})`;
  return `mirror ${mirror.hash} != source ${sourceHash}`;
}

function today() {
  // Local date, not UTC: `--updated` is a human date in a human's vault, and
  // around midnight UTC the two disagree for a third of the world.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The refusal runs on the RESOLVED absolute path, never on the config string:
// `path.join` collapses `..`, so a template like
// `01 - Projects/{project}/../../../Satset` produces a path that no string
// search for "Satset" at the front would catch, and a path that resolves
// straight into a denied folder. Same reasoning for the vault itself: a
// destination outside the vault is refused too, rather than written.
function protectedReason(registry, dest) {
  const rel = path.relative(path.resolve(registry.vault), path.resolve(dest));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return `destination "${dest}" is outside the vault "${registry.vault}"`;
  }
  const segments = rel.split(path.sep);
  for (const denied of PROTECTED_VAULT_DIRS) {
    const deniedSegs = denied.split('/');
    const prefix = segments.slice(0, deniedSegs.length);
    if (prefix.length === deniedSegs.length && prefix.every((s, i) => s === deniedSegs[i])) {
      return `destination "${dest}" is inside the vault-denied folder "${denied}/"`;
    }
  }
  return null;
}

// ---------- vault staging ----------

// Stage ONLY the one file just written. The vault's
// .obsidian/plugins/obsidian-git/data.json sets autoCommitOnlyStaged: true, so
// without an explicit `git add` the Obsidian Git plugin never commits a mirror
// and the copy silently rots in the working tree. This deliberately does NOT
// commit and does NOT push: a mirror is derived state, and committing is the
// vault owner's decision about their own history, made by the plugin on their
// schedule. A staging failure is reported as a failure, not swallowed, because
// the failure mode it prevents is silent.
function stageInVault(registry, dest) {
  const r = spawnSync('git', ['-C', path.resolve(registry.vault), 'add', '--', path.resolve(dest)], {
    encoding: 'utf8',
  });
  if (r.error) return `cannot run git: ${r.error.message}`;
  if (r.status !== 0) {
    const first = (r.stderr || r.stdout || '').trim().split('\n')[0];
    return `git add failed (exit ${r.status}): ${first || 'no output'}`;
  }
  return null;
}

// ---------- the transform's ctx ----------

// Built in ONE place so it can be asserted, and so a field cannot be added to
// the transform's contract without this being where it is supplied.
//
// `vaultRoot` MUST be passed. The transform derives the resolvable `related`
// link from `path.relative(vaultRoot, indexPath)` and is fail-closed: with no
// vaultRoot it omits `related` entirely rather than falling back to a display
// name. That makes a forgotten key here silent — every mirror would simply lose
// its inbound link, and nothing would report an error. `indexPath` and the
// predicate are the other two required pieces; the index path is the vault's
// own `indexTemplate` with {project} substituted, or null when the config
// declares no template, in which case no link is emitted and none is guessed.
export function publishCtx(registry, project, planPath, opts) {
  const indexPath = registry.indexTemplate
    ? path.join(absolute(registry.vault), registry.indexTemplate.replaceAll('{project}', project.name))
    : null;
  return {
    planPath: absolute(planPath),
    projectName: project.name,
    today: opts?.today,
    exists: (p) => existsSync(p),
    // MUST be passed, for the fail-closed reason above.
    vaultRoot: absolute(registry.vault),
    // MUST be passed: this is the file the related link points at.
    indexPath,
  };
}

// ---------- publish ----------

function publishOne(registry, rawPlanPath, opts) {
  // Resolve once, here, at the top: everything below uses this one value, so
  // the path that is routed, the path that is read and hashed, and the path
  // written as `source_path` cannot disagree.
  const planPath = absolute(rawPlanPath);
  if (!existsSync(planPath)) throw new Error(`plan file not found: ${planPath}`);
  const project = resolveProject(registry, planPath);
  const dest = destPathFor(registry, project, planPath);

  const denied = protectedReason(registry, dest);
  if (denied) throw new Error(denied);

  const planText = readFileSync(planPath, 'utf8');
  const hash = hashOf(planText);
  const stale = stalenessReason(readMirrorState(dest), hash);

  if (!stale) {
    if (opts.dryRun) {
      console.log(`🔍 DRY-RUN ${planPath}`);
      console.log(`            dest: ${dest}`);
      console.log(`            would not write: source_hash ${hash} already matches (SKIPPED-IDEMPOTENT)`);
    } else {
      console.log(`⏭️  SKIPPED-IDEMPOTENT ${planPath} -> ${dest} (source_hash ${hash} unchanged)`);
    }
    return { dest, written: false, staged: false };
  }

  const out = mergeFrontmatter(planText, publishCtx(registry, project, planPath, opts));

  const destBytes = Buffer.from(out, 'utf8');

  if (opts.dryRun) {
    const current = existsSync(dest) ? readFileSync(dest) : Buffer.alloc(0);
    const delta = destBytes.length - current.length;
    console.log(`🔍 DRY-RUN ${planPath}`);
    console.log(`            dest: ${dest}`);
    console.log(
      `            would write: ${destBytes.length} bytes `
      + `(current ${current.length}, delta ${delta >= 0 ? '+' : ''}${delta}), source_hash ${hash}`,
    );
    return { dest, written: false, staged: false };
  }

  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, out, 'utf8');

  let staged = false;
  if (registry.stageInVault) {
    const err = stageInVault(registry, dest);
    if (err) throw new Error(`${dest} was written but not staged: ${err}`);
    staged = true;
  }

  const rel = path.relative(path.resolve(registry.vault), path.resolve(dest));
  console.log(
    `✅ published ${planPath} -> ${rel} (${destBytes.length} bytes, source_hash ${hash})`
    + (staged ? ' [staged in vault]' : ' [not staged: stageInVault=false]'),
  );
  return { dest, written: true, staged };
}

// ---------- check ----------

function checkOne(registry, rawPlanPath) {
  // Same single-resolution seam as publishOne, so --check and --status report
  // on the same file the publisher would actually write, whichever way the
  // path was spelled on the command line.
  const planPath = absolute(rawPlanPath);
  const label = path.basename(planPath);
  const project = resolveProject(registry, planPath);
  const dest = destPathFor(registry, project, planPath);

  const denied = protectedReason(registry, dest);
  if (denied) return { label, dest, state: 'REFUSED', detail: denied };

  if (!existsSync(planPath)) return { label, dest, state: 'NO-SOURCE', detail: `source missing: ${planPath}` };

  const hash = hashOf(readFileSync(planPath, 'utf8'));
  if (!existsSync(dest)) {
    return { label, dest, state: 'MISSING', detail: `no mirror (source_hash ${hash})` };
  }
  // The SAME predicate the publisher uses, so --check can never call a mirror
  // current that the publisher would rewrite.
  const stale = stalenessReason(readMirrorState(dest), hash);
  if (!stale) return { label, dest, state: 'OK', detail: `source_hash ${hash}` };
  return { label, dest, state: 'DRIFT', detail: stale };
}

function runCheck(registry, planPaths, { all }) {
  let plans;
  try {
    plans = all ? enumeratePlans(registry) : planPaths;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  if (plans.length === 0) {
    console.log(all
      ? '✅ No plans found under any mirror:true project. Nothing to check.'
      : '✅ Nothing to check: no plan given and --all was not passed.');
    process.exit(0);
  }

  let failed = 0;
  for (const p of plans) {
    let row;
    try {
      row = checkOne(registry, p);
    } catch (e) {
      row = { label: path.basename(p), dest: p, state: 'ERROR', detail: e.message };
    }
    if (row.state === 'OK') {
      console.log(`✅ ${row.label} -> ${row.detail}`);
    } else {
      failed++;
      console.error(`❌ ${row.label}: ${row.state} — ${row.detail}`);
    }
  }

  if (failed === 0) {
    console.log(`✅ All ${plans.length} mirror(s) match their source.`);
    process.exit(0);
  }
  console.error(`   ${failed}/${plans.length} mirror(s) drifted or missing.`);
  console.error('   Fix: bun scripts/plan-publish.mjs <plan>   (or --all after the plan is approved)');
  process.exit(1);
}

// ---------- status ----------

// --status is a report, not a verdict: it always exits 0. A status command that
// fails is useless in a shell pipeline or a `&&` chain, and a missing mirror is
// a fact about the world, not an error in the command.
function runStatus(registry) {
  let plans;
  try {
    plans = enumeratePlans(registry);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(0);
  }

  if (plans.length === 0) {
    console.log('No plans found under any mirror:true project — nothing is mirrored yet.');
    process.exit(0);
  }

  const rows = plans.map((p) => {
    try {
      const r = checkOne(registry, p);
      return { ...r, project: resolveProject(registry, p).name };
    } catch (e) {
      return { label: path.basename(p), dest: p, project: '-', state: 'ERROR', detail: e.message };
    }
  });

  console.log('project    plan                            state    detail');
  for (const r of rows) {
    console.log(
      `${r.project.padEnd(10)} ${r.label.padEnd(31)} ${r.state.padEnd(8)} ${r.detail}`,
    );
  }

  const ok = rows.filter((r) => r.state === 'OK').length;
  console.log(`\n${ok}/${rows.length} mirrors current`
    + `   vault: ${registry.vault}`
    + `   staging: ${registry.stageInVault ? 'on (git add only, never commit)' : 'off'}`);
  process.exit(0);
}

// ---------- argument parsing ----------

function parseArgs(argv) {
  const opts = {
    mode: null, modeFlags: [], plans: [], dryRun: false, all: false,
    today: today(), help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': opts.dryRun = true; break;
      case '--all': opts.all = true; break;
      case '--check': opts.mode = opts.mode ?? 'check'; opts.modeFlags.push(a); break;
      case '--status': opts.mode = opts.mode ?? 'status'; opts.modeFlags.push(a); break;
      case '--help':
      case '-h': opts.help = true; break;
      case '--today': {
        const v = argv[++i];
        if (v === undefined) throw new UsageError('--today needs a YYYY-MM-DD value');
        if (!DATE_RE.test(v)) throw new UsageError(`--today must be YYYY-MM-DD, got "${v}"`);
        opts.today = v;
        break;
      }
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown flag "${a}"`);
        opts.plans.push(a);
    }
  }
  return opts;
}

function validateArgs(opts) {
  if (opts.help) return 'help';
  // Two modes at once means the caller expected two different outcomes from one
  // run. Guessing which one they meant is how a "--check that silently published"
  // happens, so it is a usage error instead.
  if (opts.modeFlags.length > 1) {
    throw new UsageError(`${[...new Set(opts.modeFlags)].join(' and ')} cannot be combined`);
  }
  if (opts.all && opts.mode !== 'check') throw new UsageError('--all is only meaningful with --check');
  if (opts.dryRun && opts.mode) throw new UsageError(`--dry-run is a publish option, not a ${opts.mode} option`);
  if (!opts.mode && opts.plans.length === 0) throw new UsageError('no plan files given');
  if (opts.mode === 'check' && !opts.all && opts.plans.length === 0) {
    throw new UsageError('--check needs plan files, or --all to enumerate them');
  }
  if (opts.mode && opts.plans.length > 0 && opts.mode === 'status') {
    throw new UsageError('--status takes no plan files; it reports every plan');
  }
  return opts.mode ?? 'publish';
}

// ---------- main ----------

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv.slice(2));
    const action = validateArgs(opts);
    if (action === 'help') {
      console.log(USAGE);
      process.exit(0);
    }

    const configPath = process.env.PLAN_PUBLISH_CONFIG || DEFAULT_CONFIG;
    let registry;
    try {
      registry = loadRegistry(configPath);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }

    if (action === 'status') return runStatus(registry);
    if (action === 'check') return runCheck(registry, opts.plans, { all: opts.all });

    let failed = 0;
    for (const p of opts.plans) {
      try {
        publishOne(registry, p, opts);
      } catch (e) {
        failed++;
        console.error(`❌ ${p}: ${e.message}`);
      }
    }
    process.exit(failed ? 1 : 0);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`❌ ${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('plan-publish.mjs');
if (isMain) main(process.argv);
