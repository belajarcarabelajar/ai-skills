#!/usr/bin/env bun
// The runner-contract check, on its own.
//
// Why it exists as a separate entry point: `validate-skill.mjs` renders all 27
// Mermaid blocks through a headless browser, which takes minutes. A plan's
// `skip_if` and `run[]` steps need to ask "do the template and the master
// skill still declare every key the runner reads?" in about a second, and
// `grep -q 'all N keys present' | bun scripts/validate-skill.mjs` was both slow
// and brittle: when the key count changed from 13 to 18 the grep silently
// stopped matching, so the skip fell through to the slow step and the run
// timed out. A named check with an exit code cannot drift like a string match.
//
// The comparison is STRUCTURAL, not a text search. The first draft of this check
// lived inside validate-skill and grepped for the key name; it passed even after
// `run:` was renamed to `disabled_run:`, because the word still appeared in the
// surrounding prose. Text presence is not structure, which is the same mistake
// the Mermaid contract already forbids.
//
// Revert: delete this file, and drop the `checkRunnerContract()` call from
// validate-skill.mjs in favour of the inline block it was extracted from.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNER_CONTRACT_KEYS, extractFrontmatter, parseUltraPlanYaml } from './ultra-plan-runner.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every key path present in a parsed plan, with array indices dropped so
// `tasks[].run[].cmd` and `tasks.run.cmd` compare equal.
export function keyPaths(obj, prefix = '', out = new Set()) {
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(obj)) { keyPaths(v, prefix, out); continue; } // drop the index
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p);
    keyPaths(v, p, out);
  }
  return out;
}

export function checkRunnerContract() {
  const want = RUNNER_CONTRACT_KEYS.map((k) => k.replace(/\[\]\./g, '.').replace(/\[\]/g, ''));
  const problems = [];

  const check = (artifact, planLike) => {
    const present = keyPaths(planLike);
    for (const k of want) {
      if (!present.has(k)) problems.push(`the runner reads \`${k}\` but ${artifact} does not declare it`);
    }
  };

  const templatePath = path.join(rootDir, 'templates', 'implementation-plan-template.md');
  if (!fs.existsSync(templatePath)) {
    problems.push('templates/implementation-plan-template.md is missing');
  } else {
    try {
      const { frontmatter } = extractFrontmatter(fs.readFileSync(templatePath, 'utf8'));
      check('templates/implementation-plan-template.md', parseUltraPlanYaml(frontmatter));
    } catch (e) {
      problems.push(`templates/implementation-plan-template.md has unusable frontmatter: ${e.message}`);
    }
  }

  // The master file carries the same header template inside a fenced block, so
  // the plan an agent is told to write from the skill and the plan it is told to
  // write from the template cannot diverge silently.
  try {
    const masterText = fs.readFileSync(path.join(rootDir, 'Super Ultra Code Plan Implementation.md'), 'utf8');
    const fenced = masterText.match(/```\n---\nschema: ultra-plan\/v1[\s\S]*?\n---\n/);
    if (!fenced) {
      problems.push('the master skill has no fenced `ultra-plan/v1` plan header template to check');
    } else {
      const { frontmatter } = extractFrontmatter(fenced[0].replace(/^```[^\n]*\n/, ''));
      check('the master skill plan header template', parseUltraPlanYaml(frontmatter));
    }
  } catch (e) {
    problems.push(`the master skill plan header template is unusable: ${e.message}`);
  }

  return { problems, total: want.length };
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-runner-contract.mjs');
if (isMain) {
  const { problems, total } = checkRunnerContract();
  if (problems.length === 0) {
    console.log(`✅ Runner contract: both artifacts declare all ${total} keys the runner reads.`);
    process.exit(0);
  }
  for (const p of problems) console.error(`❌ ${p}`);
  console.error(`\n   ${problems.length} contract key(s) undocumented.`);
  process.exit(1);
}
