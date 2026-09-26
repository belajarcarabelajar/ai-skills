#!/usr/bin/env node
// Ultra Plan Runner — zero-dependency orchestrator for `ultra-plan/v1` Markdown plans.
// Parses the YAML frontmatter (the runner contract), validates the task DAG,
// enforces idempotent skips, and aggregates failures into an Error Ledger.
// No MCP, no external packages — runs under Bun only.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The publisher's own freshness verdict, IMPORTED rather than re-derived. Two
// implementations of "is this mirror current?" is how a gate ends up enforcing
// a rule `plan-publish.mjs --check` does not have, and then the two disagree
// about the same file with no way to tell which one is right.
import { planFreshness } from './plan-publish.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHER = path.join(__dirname, 'plan-publish.mjs');

const SCHEMA_ID = 'ultra-plan/v1';

// ---------- Frontmatter extraction ----------

export function extractFrontmatter(md) {
  if (!md.startsWith('---')) {
    throw new Error('Missing YAML frontmatter: plan must start with a `---` fence.');
  }
  const rest = md.slice(3);
  const end = rest.search(/\r?\n---\s*(\r?\n|$)/);
  if (end === -1) {
    throw new Error('Unterminated frontmatter: no closing `---` fence found.');
  }
  const frontmatter = rest.slice(0, end).replace(/^\r?\n/, '');
  const afterIdx = rest.indexOf('\n', end + 1);
  const body = afterIdx === -1 ? '' : rest.slice(rest.indexOf('---', end) + 3).replace(/^\r?\n/, '');
  return { frontmatter, body };
}

// ---------- Minimal YAML-subset parser (ultra-plan/v1 only) ----------

function stripComment(line) {
  let inS = false, inD = false, depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD && (c === '[' || c === '{')) depth++;
    else if (!inS && !inD && (c === ']' || c === '}')) depth--;
    else if (c === '#' && !inS && !inD && depth === 0 && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function coerceScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

// Split a flow collection body by top-level commas, honoring nesting and quotes.
function splitFlow(body) {
  const out = [];
  let buf = '', inS = false, inD = false, depth = 0;
  for (const c of body) {
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    if (!inS && !inD && (c === '[' || c === '{')) depth++;
    if (!inS && !inD && (c === ']' || c === '}')) depth--;
    if (c === ',' && !inS && !inD && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim() !== '') out.push(buf);
  return out;
}

function parseValue(raw) {
  const s = raw.trim();
  if (s.startsWith('[')) {
    const inner = s.slice(1, s.lastIndexOf(']'));
    return inner.trim() === '' ? [] : splitFlow(inner).map((v) => parseValue(v));
  }
  if (s.startsWith('{')) {
    const inner = s.slice(1, s.lastIndexOf('}'));
    const obj = {};
    if (inner.trim() !== '') {
      for (const pair of splitFlow(inner)) {
        const ci = pair.indexOf(':');
        const k = pair.slice(0, ci).trim();
        obj[k] = parseValue(pair.slice(ci + 1));
      }
    }
    return obj;
  }
  return coerceScalar(s);
}

const indentOf = (l) => l.length - l.replace(/^\s+/, '').length;

export function parseUltraPlanYaml(yamlStr) {
  const lines = yamlStr.split(/\r?\n/).map(stripComment).filter((l) => l.trim() !== '');
  const plan = { defaults: {}, tasks: [] };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (indentOf(line) !== 0) { i++; continue; }
    const ci = line.indexOf(':');
    const key = line.slice(0, ci).trim();
    const inline = line.slice(ci + 1).trim();

    if (key === 'defaults') {
      i++;
      while (i < lines.length && indentOf(lines[i]) >= 2 && !lines[i].trimStart().startsWith('-')) {
        const dl = lines[i];
        const dci = dl.indexOf(':');
        plan.defaults[dl.slice(0, dci).trim()] = parseValue(dl.slice(dci + 1));
        i++;
      }
      continue;
    }
    if (key === 'tasks') {
      i++;
      let cur = null;
      while (i < lines.length && indentOf(lines[i]) >= 2) {
        const tl = lines[i];
        const trimmed = tl.trimStart();
        if (trimmed.startsWith('- ')) {
          if (cur) plan.tasks.push(cur);
          cur = {};
          const item = trimmed.slice(2);
          const ici = item.indexOf(':');
          cur[item.slice(0, ici).trim()] = parseValue(item.slice(ici + 1));
        } else if (cur) {
          const kci = trimmed.indexOf(':');
          cur[trimmed.slice(0, kci).trim()] = parseValue(trimmed.slice(kci + 1));
        }
        i++;
      }
      if (cur) plan.tasks.push(cur);
      continue;
    }
    plan[key] = parseValue(inline);
    i++;
  }
  for (const t of plan.tasks) if (!Array.isArray(t.depends_on)) t.depends_on = t.depends_on ? [t.depends_on] : [];
  return plan;
}

// ---------- Graph operations ----------

export function topoSort(tasks) {
  const ids = tasks.map((t) => t.id);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const adj = new Map(ids.map((id) => [id, []]));
  for (const t of tasks) {
    for (const dep of t.depends_on || []) {
      if (!adj.has(dep)) continue;
      adj.get(dep).push(t.id);
      indeg.set(t.id, indeg.get(t.id) + 1);
    }
  }
  const queue = ids.filter((id) => indeg.get(id) === 0).sort();
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const m of adj.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) { queue.push(m); queue.sort(); }
    }
  }
  if (order.length !== ids.length) {
    const stuck = ids.filter((id) => !order.includes(id));
    throw new Error(`Dependency cycle detected among: ${stuck.join(', ')}`);
  }
  return order;
}

export function descendants(id, tasks) {
  const children = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const dep of t.depends_on || []) if (children.has(dep)) children.get(dep).push(t.id);
  const out = new Set();
  const stack = [...(children.get(id) || [])];
  while (stack.length) {
    const n = stack.pop();
    if (out.has(n)) continue;
    out.add(n);
    for (const c of children.get(n) || []) stack.push(c);
  }
  return out;
}

// ---------- Mermaid map parsing ----------
// The Visual Implementation Map is a machine-checked contract, not prose:
// frontmatter `depends_on` == Mermaid edges == task headings. To enforce that,
// the map is parsed structurally instead of grepped for ids in raw text, so a
// task id mentioned inside an unrelated label can never satisfy the check.

// Only flowchart/graph diagrams can express the task DAG. A sequenceDiagram or
// stateDiagram-v2 in the same plan is legitimate supporting context, and its
// arrows are not dependency edges, so it is excluded from the contract check.
const FLOW_TYPES = /^(flowchart|graph)\b/i;

const ARROW_SPLIT = /(<-->|<--|-->|-\.->|---|==>|~~~|--x|--o)/;
const IDENT = /[A-Za-z][\w-]*/g;
const NODE_DECL = /([A-Za-z][\w-]*)\s*[[({]{1,2}([^\])}]*)\]/;

function lastIdent(text) {
  const m = [...text.matchAll(IDENT)];
  return m.length ? m[m.length - 1][0] : null;
}

function firstIdent(text) {
  const m = text.match(IDENT);
  return m ? m[0] : null;
}

// Returns { nodes: Set<string>, edges: Array<[from, to]> } for one diagram source.
export function parseMermaidMap(source) {
  const nodes = new Set();
  const edges = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%')) continue;

    // Mask quoted label text first so brackets, arrows, and prose inside a
    // label can never be mistaken for graph structure.
    const literals = [];
    let skeleton = line.replace(/"[^"]*"/g, (m) => `\u0000${literals.push(m) - 1}\u0000`);

    // Node declarations: record the id, drop the shape and its label.
    skeleton = skeleton.replace(NODE_DECL, (_m, id) => {
      nodes.add(id);
      return ` ${id} `;
    });

    // Edge labels such as `-->|"depends"|` are not endpoints.
    skeleton = skeleton.replace(/\|[^|]*\|/g, ' ');

    const parts = skeleton.split(ARROW_SPLIT);
    for (let i = 1; i < parts.length; i += 2) {
      const from = lastIdent(parts[i - 1]);
      const to = firstIdent(parts[i + 1]);
      if (!from || !to || from === to) continue;
      nodes.add(from);
      nodes.add(to);
      edges.push([from, to]);
    }
  }
  return { nodes, edges };
}

// Parses every ```mermaid block in a plan body and unions the result.
// `blockCount` counts all diagrams; `nodes`/`edges` come only from flowchart
// and graph diagrams, which are the only ones that can carry the task DAG.
export function parseMermaidMaps(body) {
  const blocks = body.match(/```mermaid[^\n]*\n[\s\S]*?```/g) || [];
  const nodes = new Set();
  const edges = [];
  let flowBlockCount = 0;
  for (const block of blocks) {
    const source = block.replace(/^```mermaid[^\n]*\n/, '').replace(/```\s*$/, '');
    const typeLine = source.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%'));
    if (!typeLine || !FLOW_TYPES.test(typeLine)) continue;
    flowBlockCount++;
    const parsed = parseMermaidMap(source);
    for (const n of parsed.nodes) nodes.add(n);
    edges.push(...parsed.edges);
  }
  return { nodes, edges, blockCount: blocks.length, flowBlockCount };
}

// ---------- Validation ----------

export function validatePlan(plan, body) {
  const errors = [];
  const warnings = [];
  if (plan.schema !== SCHEMA_ID) errors.push(`schema must be "${SCHEMA_ID}" (got "${plan.schema}")`);
  if (plan.runner_contract !== true) warnings.push('runner_contract is not true; plan may not be runner-managed.');

  const seen = new Set();
  for (const t of plan.tasks || []) {
    if (!t.id) { errors.push('task with no id'); continue; }
    if (seen.has(t.id)) errors.push(`duplicate task id: ${t.id}`);
    seen.add(t.id);
  }
  for (const t of plan.tasks || []) {
    for (const dep of t.depends_on || []) {
      if (!seen.has(dep)) errors.push(`task ${t.id} depends on unknown task ${dep} (GHOST reference: ${dep})`);
    }
  }
  try { topoSort(plan.tasks || []); } catch (e) { errors.push(e.message); }

  if (body) {
    const { nodes, edges, blockCount, flowBlockCount } = parseMermaidMaps(body);
    if (blockCount === 0) {
      errors.push('plan body must contain at least one ```mermaid diagram (Visual Implementation Map is mandatory)');
    } else if (flowBlockCount === 0) {
      errors.push('plan body must contain a flowchart or graph Visual Implementation Map with a node per task; '
        + 'a sequenceDiagram or stateDiagram alone cannot express the task DAG');
    } else {
      const edgeSet = new Set(edges.map(([a, b]) => `${a}\u0000${b}`));
      const depsOf = new Map((plan.tasks || []).map((t) => [t.id, t.depends_on || []]));

      for (const t of plan.tasks || []) {
        const headingRe = new RegExp(`Task\\s+${t.id}\\b`);
        if (!headingRe.test(body)) errors.push(`task ${t.id} has no matching "Task ${t.id}" heading in body`);
        if (!nodes.has(t.id)) errors.push(`task ${t.id} has no matching node in the mermaid map`);
      }

      // Flow direction: `A --> B` means B depends on A.
      for (const t of plan.tasks || []) {
        for (const dep of t.depends_on || []) {
          if (!seen.has(dep)) continue;
          if (!edgeSet.has(`${dep}\u0000${t.id}`)) {
            errors.push(`task ${t.id} depends_on ${dep} but the mermaid map has no edge ${dep} --> ${t.id}`);
          }
        }
      }

      for (const [from, to] of edges) {
        if (!seen.has(from) || !seen.has(to)) continue; // entry, gate, or exit node
        if (!(depsOf.get(to) || []).includes(from)) {
          errors.push(`mermaid map has edge ${from} --> ${to} but ${to}.depends_on does not declare ${from}`);
        }
      }
    }
  }
  return { errors, warnings };
}

// ---------- Execution ----------

function run(cmd, timeoutMs) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: timeoutMs });
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  return { exit: timedOut ? 124 : (r.status ?? 1), timedOut, stderr: r.stderr || '', stdout: r.stdout || '' };
}

export function executePlan(plan, { execute = false, log = () => {} } = {}) {
  const order = topoSort(plan.tasks);
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const retryMax = plan.defaults?.retry_transient_max ?? 1;
  const timeoutMs = (plan.defaults?.step_timeout_s ?? 120) * 1000;

  const status = new Map();
  const ledger = [];
  const failed = new Set();

  for (const id of order) {
    const t = byId.get(id);
    const upstreamFail = (t.depends_on || []).some((d) => failed.has(d) || status.get(d) === 'HALTED-UPSTREAM');
    if (upstreamFail) {
      status.set(id, 'HALTED-UPSTREAM');
      ledger.push({ task: id, step: '-', klass: 'contract', exit: '-', cause: 'upstream dependency failed', retry: '0/0', status: 'HALTED-UPSTREAM' });
      log(`  ${id}: HALTED-UPSTREAM`);
      continue;
    }

    if (!execute) { status.set(id, 'READY'); log(`  ${id}: READY (dry-run)`); continue; }

    if (t.skip_if) {
      const r = run(t.skip_if, timeoutMs);
      if (r.exit === 0) { status.set(id, 'SKIPPED-IDEMPOTENT'); log(`  ${id}: SKIPPED-IDEMPOTENT (skip_if exit 0)`); continue; }
    }

    if (!Array.isArray(t.run) || t.run.length === 0) {
      status.set(id, 'NEEDS-AGENT');
      log(`  ${id}: NEEDS-AGENT (no frontmatter run[]; agent executes prose steps)`);
      continue;
    }

    let ok = true, failStep = null, lastExit = 0, usedRetry = 0;
    for (let s = 0; s < t.run.length; s++) {
      const step = t.run[s];
      const want = step.expect_exit ?? 0;
      const stepRetry = step.retry ?? retryMax;
      let attempt = 0, r;
      do {
        r = run(step.cmd, timeoutMs);
        attempt++;
        if (r.exit === want) break;
      } while (attempt <= stepRetry);
      usedRetry += attempt - 1;
      if (r.exit !== want) { ok = false; failStep = s + 1; lastExit = r.exit; break; }
    }

    if (ok) { status.set(id, 'PASSED'); log(`  ${id}: PASSED`); continue; }
    failed.add(id);
    const hasChildren = descendants(id, plan.tasks).size > 0;
    const st = hasChildren ? 'FAILED-BLOCKING' : 'FAILED-ISOLATED';
    status.set(id, st);
    ledger.push({ task: id, step: failStep, klass: 'code', exit: lastExit, cause: 'step command exit mismatch', retry: `${usedRetry}/${retryMax}`, status: st });
    log(`  ${id}: ${st} at step ${failStep} (exit ${lastExit})`);
  }
  return { order, status, ledger };
}

export function renderLedger(ledger) {
  if (ledger.length === 0) return 'Error Ledger: (empty — no failures)';
  const head = '| Task | Step | Classification | Exit | Root cause | Retry used | Status |\n|---|---|---|---|---|---|---|';
  const rows = ledger.map((e) => `| ${e.task} | ${e.step} | ${e.klass} | ${e.exit} | ${e.cause} | ${e.retry} | \`${e.status}\` |`);
  return `## Error Ledger\n${head}\n${rows.join('\n')}`;
}

// ---------- CLI ----------

// ---------- vault mirror gate ----------
//
// Why this is a gate and not a warning: the mirror is what a human reads when
// they review a plan. A plan that executes without ever reaching the vault was
// reviewed by nobody, in a place they were not looking. Making execution depend
// on the mirror is the only point in the pipeline where "publish the plan" can
// stop being advice.
//
// It runs AFTER validation and BEFORE any task step, and only for --execute.
// A dry run deliberately never consults it: validating a plan is reading and
// writing documents, which must work on a machine with no vault at all.
//
// Fail CLOSED when the verdict cannot be reached. A gate that quietly passes
// because it could not check is worse than no gate, because it manufactures
// confidence that was never earned — the same failure mode the CI version of
// this check documents.
//
// Exit 3 is deliberately distinct: 2 is already usage error and 1 is already
// validation or task failure, so a caller can tell "you forgot to publish" from
// "the plan is broken" without parsing text.

export const EXIT_MIRROR_GATE = 3;

function mirrorGate(planPath, { skip }) {
  const verdict = planFreshness(planPath);

  if (skip) {
    // Loud every time. An escape hatch that passes quietly becomes the default
    // within a week, and then nobody is publishing again.
    console.log(`⚠️  MIRROR GATE: SKIPPED by --skip-mirror-gate — ${verdict.state}${verdict.detail ? ` — ${verdict.detail}` : ''}`);
    console.log('   The plan executes without a current vault mirror. Re-publish, and drop the flag.\n');
    return null;
  }

  // Not applicable means there is no mirror by design (the vault's own plans,
  // declared mirror:false because publishing one would copy a file onto
  // itself). It is not a pass: it is the absence of a check, and it says so.
  if (!verdict.applicable) return null;
  if (verdict.state === 'OK') return null;

  console.error('MIRROR GATE: BLOCKED — refusing to execute a plan with no current Obsidian mirror.\n');
  console.error(`  plan     ${path.resolve(planPath)}`);
  if (verdict.project) console.error(`  project  ${verdict.project}`);
  if (verdict.dest) console.error(`  mirror   ${verdict.dest}`);
  console.error(`  state    ${verdict.state}`);
  if (verdict.detail) console.error(`  reason   ${verdict.detail}`);
  console.error('\n  The plan is still valid and still saved in its project repository. The mirror is');
  console.error('  derived state, so the fix is to publish it, not to change the plan:\n');
  // Absolute paths on purpose: the publisher resolves its input to an absolute
  // path anyway, and the person hitting this may be in any project directory,
  // where a repo-relative `bun scripts/plan-publish.mjs` does not exist.
  console.error(`    bun ${PUBLISHER} ${path.resolve(planPath)}`);
  if (process.env.PLAN_PUBLISH_CONFIG) {
    console.error(`\n  (registry override in use: ${process.env.PLAN_PUBLISH_CONFIG})`);
  }
  console.error('\n  To execute anyway, pass --skip-mirror-gate. It prints a warning every time.');
  return EXIT_MIRROR_GATE;
}

function main(argv) {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const execute = args.includes('--execute');
  const asJson = args.includes('--json');
  const skipGate = args.includes('--skip-mirror-gate');
  if (!file) {
    console.error('usage: ultra-plan-runner <plan.md> [--execute] [--json] [--skip-mirror-gate]');
    console.error('  --execute          run the DAG (requires a current Obsidian mirror; exit 3 if not)');
    console.error('  --skip-mirror-gate run the DAG anyway, with a warning (every time)');
    process.exit(2);
  }
  if (skipGate && !execute) {
    // Refuse rather than ignore: silently discarding a flag that exists to
    // suspend a safety check is how someone comes to believe the check is off.
    console.error('--skip-mirror-gate only means anything with --execute; it has no effect on a dry run.');
    process.exit(2);
  }
  const md = readFileSync(file, 'utf8');
  const { frontmatter, body } = extractFrontmatter(md);
  const plan = parseUltraPlanYaml(frontmatter);
  const { errors, warnings } = validatePlan(plan, body);

  // The gate sits after validation and before any task step, and only for
  // --execute. A plan that fails validation cannot run at all, so gating it
  // would report the wrong problem: it would blame the mirror for a plan that
  // was going to be rejected anyway.
  if (execute && !errors.length) {
    const blocked = mirrorGate(file, { skip: skipGate });
    if (blocked) process.exit(blocked);
  }

  if (asJson) {
    const { order, status, ledger } = errors.length ? { order: [], status: new Map(), ledger: [] } : executePlan(plan, { execute });
    console.log(JSON.stringify({ plan_id: plan.plan_id, errors, warnings, order, status: Object.fromEntries(status), ledger }, null, 2));
    process.exit(errors.length || ledger.length ? 1 : 0);
  }

  console.log(`Plan: ${plan.plan_id}  schema=${plan.schema}  status=${plan.status}  tasks=${plan.tasks.length}`);
  for (const w of warnings) console.log(`  WARN: ${w}`);
  if (errors.length) {
    console.log('\nVALIDATION FAILED:');
    for (const e of errors) console.log(`  ERROR: ${e}`);
    process.exit(1);
  }
  console.log('Validation: OK\n');
  console.log(execute ? 'Executing DAG (topological order):' : 'Dry-run DAG (topological order); pass --execute to run:');
  const { ledger } = executePlan(plan, { execute, log: (m) => console.log(m) });
  console.log('\n' + renderLedger(ledger));
  process.exit(ledger.length ? 1 : 0);
}

const isMain = process.argv[1] && process.argv[1].endsWith('ultra-plan-runner.mjs');
if (isMain) main(process.argv);
