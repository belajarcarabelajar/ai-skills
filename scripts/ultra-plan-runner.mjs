#!/usr/bin/env node
// Ultra Plan Runner — zero-dependency orchestrator for `ultra-plan/v1` Markdown plans.
// Parses the YAML frontmatter (the runner contract), validates the task DAG,
// enforces idempotent skips, and aggregates failures into an Error Ledger.
// No MCP, no external packages — runs under Bun only.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
    const mermaidBlocks = body.match(/```mermaid[\s\S]*?```/g) || [];
    if (mermaidBlocks.length === 0) {
      errors.push('plan body must contain at least one ```mermaid diagram (Visual Implementation Map is mandatory)');
    }
    for (const t of plan.tasks || []) {
      const headingRe = new RegExp(`Task\\s+${t.id}\\b`);
      const mermaidRe = new RegExp(`\\b${t.id}\\b`);
      const mermaidBlock = mermaidBlocks.join('\n');
      if (!headingRe.test(body)) errors.push(`task ${t.id} has no matching "Task ${t.id}" heading in body`);
      if (!mermaidRe.test(mermaidBlock)) errors.push(`task ${t.id} has no matching node in the mermaid map`);
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

function main(argv) {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const execute = args.includes('--execute');
  const asJson = args.includes('--json');
  if (!file) {
    console.error('usage: ultra-plan-runner <plan.md> [--execute] [--json]');
    process.exit(2);
  }
  const md = readFileSync(file, 'utf8');
  const { frontmatter, body } = extractFrontmatter(md);
  const plan = parseUltraPlanYaml(frontmatter);
  const { errors, warnings } = validatePlan(plan, body);

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
