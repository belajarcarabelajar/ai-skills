#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { RUNNER_CONTRACT_KEYS, extractFrontmatter, parseUltraPlanYaml } from './ultra-plan-runner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('==> Validating Ultimate All-in-One AI Skills Repository...');
let errors = 0;

// 0b. The runner contract must match what the plan template documents.
//
// Why this check exists: `files`, `idempotency_key`, `verify_exit`, and
// `defaults.on_precondition_fail` were all documented in the template and none
// of them was ever read by the runner, while `run[]` — the only key that makes
// the runner execute anything — was documented nowhere, appeared in zero plans,
// and had zero test coverage. CI was green the entire time, because nothing
// compared the documentation against the code that consumes it.
//
// The key list is imported from the runner itself rather than restated here, so
// the check cannot itself rot: adding a key to RUNNER_CONTRACT_KEYS without
// documenting it fails this check.
//
// The comparison is STRUCTURAL, not a text search. The first draft of this
// check grepped the template for the key name, and it passed even after `run:`
// was renamed to `disabled_run:` — because the word "run" still appears in the
// surrounding prose. That is precisely the "grep the diagram for a task id"
// mistake this skill already forbids elsewhere: text presence is not structure.
{
  const templatePath = path.join(rootDir, 'templates', 'implementation-plan-template.md');
  const masterFile = path.join(rootDir, 'Super Ultra Code Plan Implementation.md');

  // Every key path present in a parsed plan, with array indices dropped so
  // `tasks[].run[].cmd` and `tasks.run.cmd` compare equal.
  function keyPaths(obj, prefix = '', out = new Set()) {
    if (obj === null || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(obj)) { keyPaths(v, prefix, out); continue; } // drop the index
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      keyPaths(v, p, out);
    }
    return out;
  }

  const contractPaths = RUNNER_CONTRACT_KEYS.map((k) => k.replace(/\[\]\./g, '.').replace(/\[\]/g, ''));

  function check(artifact, planLike) {
    const present = keyPaths(planLike);
    const missing = contractPaths.filter((k) => !present.has(k));
    if (missing.length === 0) {
      console.log(`✅ Runner contract documented in ${artifact}: all ${contractPaths.length} keys present.`);
      return 0;
    }
    for (const k of missing) {
      console.error(`❌ The runner reads \`${k}\` but ${artifact} does not declare it.`);
    }
    return missing.length;
  }

  if (!fs.existsSync(templatePath)) {
    console.error('❌ Plan template missing: templates/implementation-plan-template.md');
    errors++;
  } else {
    try {
      const { frontmatter } = extractFrontmatter(fs.readFileSync(templatePath, 'utf8'));
      errors += check('templates/implementation-plan-template.md', parseUltraPlanYaml(frontmatter));
    } catch (e) {
      console.error(`❌ templates/implementation-plan-template.md has unusable frontmatter: ${e.message}`);
      errors++;
    }
  }

  // The master file carries the same header template inside a fenced block, so
  // the plan an agent is told to write from the skill and the plan it is told to
  // write from the template cannot diverge silently.
  try {
    const masterText = fs.readFileSync(masterFile, 'utf8');
    const fenced = masterText.match(/```\n---\nschema: ultra-plan\/v1[\s\S]*?\n---\n/);
    if (!fenced) {
      console.error('❌ Master file has no fenced `ultra-plan/v1` plan header template to check.');
      errors++;
    } else {
      const { frontmatter } = extractFrontmatter(fenced[0].replace(/^```[^\n]*\n/, ''));
      errors += check('the master skill plan header template', parseUltraPlanYaml(frontmatter));
    }
  } catch (e) {
    console.error(`❌ Master file plan header template is unusable: ${e.message}`);
    errors++;
  }
}

// 0. Check Mandatory Prerequisites: tgrep
try {
  const tgrepOut = execSync('tgrep --version 2>&1 || ~/.local/bin/tgrep --version 2>&1', { encoding: 'utf8' }).trim().split('\n')[0];
  console.log(`✅ Prerequisite verified: ${tgrepOut}`);
} catch (err) {
  console.error('❌ Prerequisite missing: tgrep (microsoft/tgrep) is mandatory.');
  errors++;
}

// 1. Check Master File & Frontmatter
const masterPath = path.join(rootDir, 'Super Ultra Code Plan Implementation.md');
if (!fs.existsSync(masterPath)) {
  console.error('❌ Master file missing: Super Ultra Code Plan Implementation.md');
  errors++;
} else {
  const content = fs.readFileSync(masterPath, 'utf8');
  if (!content.startsWith('---')) {
    console.error('❌ Master file missing YAML frontmatter opening (---)');
    errors++;
  } else {
    const endFrontmatter = content.indexOf('\n---', 3);
    if (endFrontmatter === -1) {
      console.error('❌ Master file missing YAML frontmatter closing (---)');
      errors++;
    } else {
      const frontmatter = content.substring(3, endFrontmatter);
      const hasName = /name:\s*[\w-]+/.test(frontmatter);
      const hasDesc = /description:\s*.+/.test(frontmatter);
      const hasTriggers = /triggers:/.test(frontmatter);

      if (!hasName || !hasDesc || !hasTriggers) {
        console.error('❌ Frontmatter missing required fields (name, description, triggers)');
        errors++;
      } else {
        console.log('✅ Master file YAML frontmatter valid.');
      }
    }
  }

  // Token estimate (~4 chars per token)
  const charCount = content.length;
  const wordCount = content.trim().split(/\s+/).length;
  const estimatedTokens = Math.round(charCount / 4);
  console.log(`📊 Master file stats: ${charCount} chars, ${wordCount} words, ~${estimatedTokens} estimated tokens.`);

  // 1b. Mandatory Session-Close Debt Sweep contract must stay in the master file.
  // Silently dropping this stage would let every session end with unexamined technical debt.
  const sweepContract = [
    { label: 'Step 6 debt sweep heading', re: /^##\s*6️⃣.*Debt Sweep/m },
    { label: 'Done 100% saturation rule', re: /Plan Completion Saturation Rule/ },
    { label: 'NOW/LATER debt classification', re: /`NOW`/ },
    { label: 'default 3-5 follow-up cap', re: /3-5 follow-up questions|3-5 follow-ups/ },
    { label: 'harness multi-select question injection', re: /multi-select checkboxes/ },
    { label: 'debt sweep template reference', re: /templates\/follow-up-injection-template\.md/ },
  ];
  for (const contract of sweepContract) {
    if (contract.re.test(content)) {
      console.log(`✅ Debt sweep contract present: ${contract.label}`);
    } else {
      console.error(`❌ Master file missing debt sweep contract: ${contract.label}`);
      errors++;
    }
  }
}

// 2. Check Symlinks in skills/super-ultra-code-plan/
const skillDir = path.join(rootDir, 'skills', 'super-ultra-code-plan');
const requiredSkillLinks = ['SKILL.md', 'templates', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json'];

for (const linkName of requiredSkillLinks) {
  const p = path.join(skillDir, linkName);
  if (!fs.existsSync(p)) {
    console.error(`❌ skills/super-ultra-code-plan/${linkName} does not exist.`);
    errors++;
  } else {
    try {
      const target = fs.readlinkSync(p);
      console.log(`✅ Symlink valid: skills/super-ultra-code-plan/${linkName} -> ${target}`);
    } catch (err) {
      console.error(`❌ Failed to read symlink ${linkName}: ${err.message}`);
      errors++;
    }
  }
}

// 3. Check Templates
const requiredTemplates = [
  'implementation-plan-template.md',
  'spike-report-template.md',
  'systematic-debugging-log-template.md',
  'verification-checklist-template.md',
  'handoff-template.md',
  'progress-log-template.md',
  'adr-template.md',
  'subagent-contract-template.md',
  'code-review-template.md',
  'deep-research-report-template.md',
  'follow-up-injection-template.md',
];

for (const tmpl of requiredTemplates) {
  const p = path.join(rootDir, 'templates', tmpl);
  if (fs.existsSync(p)) {
    console.log(`✅ Template present: templates/${tmpl}`);
  } else {
    console.error(`❌ Missing template: templates/${tmpl}`);
    errors++;
  }
}

// 3b. Mandatory Mermaid presence: every planning artifact template must embed at least one mermaid block
const mermaidRequiredTemplates = [
  'implementation-plan-template.md',
  'spike-report-template.md',
  'systematic-debugging-log-template.md',
  'verification-checklist-template.md',
  'adr-template.md',
  'subagent-contract-template.md',
  'code-review-template.md',
  'follow-up-injection-template.md',
];
for (const tmpl of mermaidRequiredTemplates) {
  const p = path.join(rootDir, 'templates', tmpl);
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, 'utf8');
    if (/```mermaid[\s\S]*?```/.test(content)) {
      console.log(`✅ Mermaid present: templates/${tmpl}`);
    } else {
      console.error(`❌ templates/${tmpl} must contain at least one \`\`\`mermaid diagram (planning always uses Mermaid).`);
      errors++;
    }
  }
}

// 3c. Trigger snippets must carry the mandatory subagent contract.
// A trigger prompt that omits it is the most common cause of an agent quietly
// implementing everything inline, so its absence is a build failure.
const requiredSnippetTerms = [
  'SUBAGENT-FIRST',
  'TASK-CHUNKING',
  'BATCH MANIFEST',
  'HIGH FAN-OUT FLOOR',
  'NON-OVERLAPPING',
  'NESTED FAN-OUT',
  'GATHER & SYNTHESIZE',
  'PARENT DIFF AUDIT GATE',
  'subagent-contract-template.md',
];
const requiredSnippets = [
  'orkestrasi-ngoding-plan.md',
  'orkestrasi-debugging.md',
];
for (const snip of requiredSnippets) {
  const p = path.join(rootDir, 'snippets', snip);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing trigger snippet: snippets/${snip}`);
    errors++;
    continue;
  }
  const body = fs.readFileSync(p, 'utf8');
  const missing = requiredSnippetTerms.filter((term) => !body.includes(term));
  if (missing.length === 0) {
    console.log(`✅ Trigger snippet carries the subagent contract: snippets/${snip}`);
  } else {
    console.error(`❌ snippets/${snip} is missing required subagent terms: ${missing.join(', ')}`);
    errors++;
  }
}

// 3d. Trigger snippets must not invoke the runtime the skill prohibits.
// The master skill bans npm/npx/bare node in favour of Bun; a snippet that
// reintroduces them is a self-violating instruction.
for (const snip of requiredSnippets) {
  const p = path.join(rootDir, 'snippets', snip);
  if (!fs.existsSync(p)) continue;
  const body = fs.readFileSync(p, 'utf8');
  const banned = ['node scripts/', 'npm install', 'npm test', 'npx ']
    .filter((needle) => body.includes(needle));
  if (banned.length === 0) {
    console.log(`✅ Trigger snippet respects the Bun runtime rule: snippets/${snip}`);
  } else {
    console.error(`❌ snippets/${snip} uses a prohibited runtime: ${banned.join(', ')} (use bun)`);
    errors++;
  }
}

// 3e. The snippet manifest must stay consistent with the files it tracks.
// The database comparison itself needs a local Snipset install and runs in
// `bun run snippets:check`, but these invariants hold everywhere, including CI.
{
  const manifestPath = path.join(rootDir, 'snippets.manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('❌ Missing snippets.manifest.json (source-to-database mapping)');
    errors++;
  } else {
    let manifest = null;
    const before = errors;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      console.error(`❌ snippets.manifest.json is not valid JSON: ${e.message}`);
      errors++;
    }
    if (manifest) {
      const entries = Array.isArray(manifest.snippets) ? manifest.snippets : [];
      if (entries.length === 0) {
        console.error('❌ snippets.manifest.json has no entries');
        errors++;
      }
      const uuids = new Set();
      const keywords = new Set();
      for (const e of entries) {
        for (const field of ['source', 'uuid', 'keyword', 'name', 'description']) {
          if (!e[field]) {
            console.error(`❌ snippets.manifest.json entry ${e.source || '(no source)'} is missing "${field}"`);
            errors++;
          }
        }
        if (uuids.has(e.uuid)) {
          console.error(`❌ snippets.manifest.json has duplicate uuid: ${e.uuid}`);
          errors++;
        }
        uuids.add(e.uuid);
        if (keywords.has(e.keyword)) {
          console.error(`❌ snippets.manifest.json has duplicate keyword: ${JSON.stringify(e.keyword)}`);
          errors++;
        }
        keywords.add(e.keyword);
        if (e.source && !fs.existsSync(path.join(rootDir, e.source))) {
          console.error(`❌ snippets.manifest.json references a missing file: ${e.source}`);
          errors++;
        }
        // Every tracked source must itself carry the subagent contract, so a
        // database copy can never be the only place the rules exist.
        if (e.source && fs.existsSync(path.join(rootDir, e.source))) {
          const body = fs.readFileSync(path.join(rootDir, e.source), 'utf8');
          const missing = requiredSnippetTerms.filter((term) => !body.includes(term));
          if (missing.length > 0) {
            console.error(`❌ ${e.source} is tracked in the manifest but is missing: ${missing.join(', ')}`);
            errors++;
          }
        }
      }
      // Conversely, every required trigger snippet must be tracked, or it can
      // never be synced to the database.
      for (const snip of requiredSnippets) {
        const rel = `snippets/${snip}`;
        if (!entries.some((e) => e.source === rel)) {
          console.error(`❌ ${rel} is not tracked in snippets.manifest.json; it can never reach the database`);
          errors++;
        }
      }
      if (errors === before) {
        console.log(`✅ Snippet manifest valid: ${entries.length} tracked entr(ies), no duplicate uuid or keyword.`);
      }
    }
  }
}

// 3b. Check Examples directory
const examplesDir = path.join(rootDir, 'examples');
const requiredExamples = ['worked-example.md', 'deep-research-worked-example.md'];
for (const ex of requiredExamples) {
  const p = path.join(examplesDir, ex);
  if (fs.existsSync(p)) {
    console.log(`✅ Example present: examples/${ex}`);
  } else {
    console.error(`❌ Missing example: examples/${ex}`);
    errors++;
  }
}

// 4. Check Executable Scripts
const scripts = ['install.sh', 'scripts/sync.sh', 'scripts/render-diagrams.sh'];
for (const scr of scripts) {
  const p = path.join(rootDir, scr);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing script: ${scr}`);
    errors++;
  } else {
    console.log(`✅ Script present: ${scr}`);
  }
}

// 4b. Mandatory Plan Publishing contract. A skill contract that can be silently
// deleted is not a contract, so the mandate wording, the CLI it names, and the
// registry the CLI reads are each asserted separately. Placed before section 5
// on purpose: section 5 renders every Mermaid block in the repository with mmdc
// and costs 60-120 seconds, so a cheap missing-contract error must not queue
// behind the expensive render pass.
{
  const planPublishContract = [
    { label: 'Plan Publishing heading', needle: 'Plan Publishing' },
    { label: 'publisher CLI reference', needle: 'plan-publish.mjs' },
    { label: 'idempotency marker', needle: 'SKIPPED-IDEMPOTENT' },
  ];
  if (!fs.existsSync(masterPath)) {
    // Section 1 already counted the missing master file. Re-reading it here
    // would triple-count one root cause, so the wording checks are skipped and
    // the filesystem checks below still run.
    console.error('❌ Plan publishing contract cannot be checked: the master file is missing (see section 1).');
  } else {
    const masterBody = fs.readFileSync(masterPath, 'utf8');
    for (const c of planPublishContract) {
      if (masterBody.includes(c.needle)) {
        console.log(`✅ Plan publishing contract present: ${c.label}`);
      } else {
        console.error(`❌ Master file missing plan publishing contract: ${c.label} — literal "${c.needle}" not found.`);
        errors++;
      }
    }
  }

  const publisherPath = path.join(rootDir, 'scripts', 'plan-publish.mjs');
  if (fs.existsSync(publisherPath)) {
    console.log('✅ Script present: scripts/plan-publish.mjs');
  } else {
    console.error('❌ Missing script: scripts/plan-publish.mjs (the Plan Publishing mandate names a CLI that does not exist).');
    errors++;
  }

  const publishConfigPath = path.join(rootDir, 'plans.publish.json');
  if (!fs.existsSync(publishConfigPath)) {
    console.error('❌ Missing plans.publish.json (publish registry; the publisher cannot resolve a vault without it).');
    errors++;
  } else {
    try {
      JSON.parse(fs.readFileSync(publishConfigPath, 'utf8'));
      console.log('✅ Plan publish registry is valid JSON: plans.publish.json');
    } catch (e) {
      console.error(`❌ plans.publish.json is not valid JSON: ${e.message}`);
      errors++;
    }
  }

  // PUBLISHER_VERSION is a BUMP OBLIGATION, not bookkeeping, and this is the
  // only thing in the repository that enforces it. Freshness in
  // plan-publish.mjs keys on publisher_version as well as on source_hash, so a
  // change to the transform that alters published output MUST increment this
  // constant. If it is not bumped, every mirror written by the previous version
  // keeps reporting itself current and never heals — the exact failure this
  // constant was added to fix, and it is silent. Nothing else would notice.
  //
  // This IMPORTS the module and inspects the real export rather than grepping
  // the source: a text search for the word passes when the identifier appears in
  // a comment, which is precisely the state this guard exists to catch.
  const frontmatterModulePath = path.join(rootDir, 'scripts', 'plan-publish-frontmatter.mjs');
  if (!fs.existsSync(frontmatterModulePath)) {
    console.error('❌ Missing script: scripts/plan-publish-frontmatter.mjs (the transform whose PUBLISHER_VERSION gates mirror freshness does not exist).');
    errors++;
  } else {
    let observedVersion;
    let probeFailure = null;
    try {
      const mod = await import(frontmatterModulePath);
      observedVersion = mod.PUBLISHER_VERSION;
    } catch (e) {
      probeFailure = e;
    }
    if (probeFailure) {
      console.error(`❌ Cannot load scripts/plan-publish-frontmatter.mjs to read PUBLISHER_VERSION: ${probeFailure.message}`);
      errors++;
    } else if (!Number.isInteger(observedVersion)) {
      console.error(`❌ scripts/plan-publish-frontmatter.mjs must DEFINE and EXPORT an integer PUBLISHER_VERSION; the export is ${observedVersion === undefined ? 'absent' : `${typeof observedVersion} ${JSON.stringify(observedVersion)}`}. Mirrors would never be invalidated when the transform changes.`);
      errors++;
    } else {
      console.log(`✅ Plan publish freshness stamp exported: PUBLISHER_VERSION = ${observedVersion}`);
    }
  }
}

// 5. Mermaid Block Validation
const mmdcPath = path.join(rootDir, 'node_modules', '.bin', 'mmdc');
const mmdcAvailable = fs.existsSync(mmdcPath) ||
  (() => { try { execSync('mmdc --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

if (!mmdcAvailable) {
  // Hard error, not a warning. A silently skipped render gate is worse than no
  // gate: it reports success while proving nothing. See the Zero-Tolerance
  // Clean Pass rule in the master skill.
  console.error('❌ mmdc not found — mermaid validation cannot run, so the gate would prove nothing.');
  console.error('   Install the pinned toolchain first: bun install');
  errors++;
} else {
  const mmdc = fs.existsSync(mmdcPath) ? mmdcPath : 'mmdc';
  const mdFiles = [];

  function findMdFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'diagrams') continue;
      const full = path.join(dir, entry.name);
      // Skip symlinks: skills/*/SKILL.md points at the master file, so scanning
      // it would validate (and later render) every diagram twice.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) findMdFiles(full);
      else if (entry.name.endsWith('.md')) mdFiles.push(full);
    }
  }
  findMdFiles(rootDir);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mermaid-'));
  let mermaidValid = 0;
  let mermaidInvalid = 0;
  let mermaidMissingA11y = 0;

  // Accessibility contract: every diagram must carry accTitle + accDescr, which
  // mermaid emits as <title>/<desc> wired to aria-labelledby. Without them the
  // SVG is an unlabelled graphic for screen readers.
  const a11yRe = /accTitle:[^\n]*\n\s*accDescr:/;

  for (const mdFile of mdFiles) {
    const content = fs.readFileSync(mdFile, 'utf8');
    const blocks = [];
    const blockRe = /```mermaid\n([\s\S]*?)```/g;
    let match;
    while ((match = blockRe.exec(content)) !== null) {
      blocks.push(match[1].trim());
    }

    for (let i = 0; i < blocks.length; i++) {
      const rel = path.relative(rootDir, mdFile);
      const tmpIn = path.join(tmpDir, `block-${mermaidValid + mermaidInvalid + 1}.mmd`);
      const tmpOut = path.join(tmpDir, `block-${mermaidValid + mermaidInvalid + 1}.svg`);
      fs.writeFileSync(tmpIn, blocks[i]);
      const puppeteerCfg = path.join(rootDir, 'puppeteer-config.json');
      const mermaidCfg = path.join(rootDir, 'mermaid.config.json');
      const cfgFlag = [
        fs.existsSync(mermaidCfg) ? ` -c "${mermaidCfg}"` : '',
        fs.existsSync(puppeteerCfg) ? ` -p "${puppeteerCfg}"` : '',
      ].join('');
      try {
        execSync(`"${mmdc}"${cfgFlag} -b transparent --input "${tmpIn}" --output "${tmpOut}"`, { stdio: 'pipe' });
        mermaidValid++;
      } catch (err) {
        console.error(`❌ Mermaid syntax error in ${rel} [block ${i + 1}]`);
        console.error(`   ${err.stderr?.toString().trim().split('\n')[0] || 'unknown error'}`);
        mermaidInvalid++;
        errors++;
        continue;
      }

      if (!a11yRe.test(blocks[i])) {
        console.error(`❌ Missing accessibility metadata in ${rel} [block ${i + 1}]: add accTitle + accDescr.`);
        mermaidMissingA11y++;
        errors++;
      }
    }
  }

  // Cleanup temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (mermaidInvalid > 0) {
    console.error(`❌ Mermaid validation: ${mermaidValid} valid, ${mermaidInvalid} invalid block(s).`);
  } else {
    console.log(`✅ Mermaid validation: ${mermaidValid} block(s) valid.`);
  }

  if (mermaidMissingA11y > 0) {
    console.error(`❌ Accessibility: ${mermaidMissingA11y} diagram(s) lack accTitle/accDescr.`);
  } else {
    console.log('✅ Accessibility: every diagram carries accTitle + accDescr.');
  }
}

// 6. Mermaid theming config must exist and stay paired with the renderer.
const themeConfigs = [
  ['mermaid.config.json', 'light'],
  ['mermaid.dark.config.json', 'dark'],
];
for (const [cfg, variant] of themeConfigs) {
  const p = path.join(rootDir, cfg);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing mermaid ${variant} config: ${cfg}`);
    errors++;
    continue;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed.fontFamily) {
      console.error(`❌ ${cfg} must pin fontFamily; an unpinned font re-flows labels per viewer.`);
      errors++;
    } else if (!parsed.theme) {
      console.error(`❌ ${cfg} must pin theme.`);
      errors++;
    } else {
      console.log(`✅ Mermaid ${variant} config valid: theme=${parsed.theme}, fontFamily=${parsed.fontFamily}`);
    }
  } catch (e) {
    console.error(`❌ ${cfg} is not valid JSON: ${e.message}`);
    errors++;
  }
}

// 7. The committed README hero must exist; GitHub does not render Mermaid in raw HTML.
for (const hero of ['lifecycle.svg', 'lifecycle-dark.svg']) {
  const p = path.join(rootDir, 'diagrams', hero);
  if (fs.existsSync(p)) {
    console.log(`✅ Committed hero present: diagrams/${hero}`);
  } else {
    console.error(`❌ Missing committed hero: diagrams/${hero} (run: bash scripts/render-diagrams.sh)`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n❌ Validation failed with ${errors} error(s).`);
  process.exit(1);
} else {
  console.log('\n✅ All validations passed successfully!');
}
