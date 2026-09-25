#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('==> Validating Ultimate All-in-One AI Skills Repository...');
let errors = 0;

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
}

// 2. Check Symlinks in skills/super-ultra-code-plan/
const skillDir = path.join(rootDir, 'skills', 'super-ultra-code-plan');
const requiredSkillLinks = ['SKILL.md', 'templates', 'examples'];

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

// 3b. Check Examples directory
const examplesDir = path.join(rootDir, 'examples');
const requiredExamples = ['worked-example.md'];
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

// 5. Mermaid Block Validation
const mmdcPath = path.join(rootDir, 'node_modules', '.bin', 'mmdc');
const mmdcAvailable = fs.existsSync(mmdcPath) ||
  (() => { try { execSync('mmdc --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

if (!mmdcAvailable) {
  console.warn('⚠️  mmdc not found — skipping mermaid block validation. Run: bun install');
} else {
  const mmdc = fs.existsSync(mmdcPath) ? mmdcPath : 'mmdc';
  const mdFiles = [];

  function findMdFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'diagrams') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findMdFiles(full);
      else if (entry.name.endsWith('.md')) mdFiles.push(full);
    }
  }
  findMdFiles(rootDir);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mermaid-'));
  let mermaidValid = 0;
  let mermaidInvalid = 0;

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
      const cfgFlag = fs.existsSync(puppeteerCfg) ? ` -p "${puppeteerCfg}"` : '';
      try {
        execSync(`"${mmdc}"${cfgFlag} --input "${tmpIn}" --output "${tmpOut}"`, { stdio: 'pipe' });
        mermaidValid++;
      } catch (err) {
        console.error(`❌ Mermaid syntax error in ${rel} [block ${i + 1}]`);
        console.error(`   ${err.stderr?.toString().trim().split('\n')[0] || 'unknown error'}`);
        mermaidInvalid++;
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
}

if (errors > 0) {
  console.error(`\n❌ Validation failed with ${errors} error(s).`);
  process.exit(1);
} else {
  console.log('\n✅ All validations passed successfully!');
}
