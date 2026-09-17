#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('==> Validating Ultimate All-in-One AI Skills Repository...');
let errors = 0;

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

// 2. Check Symlink in skills/
const symlinkPath = path.join(rootDir, 'skills', 'super-ultra-code-plan', 'SKILL.md');
if (!fs.existsSync(symlinkPath)) {
  console.error('❌ skills/super-ultra-code-plan/SKILL.md does not exist.');
  errors++;
} else {
  try {
    const target = fs.readlinkSync(symlinkPath);
    console.log(`✅ Symlink valid: skills/super-ultra-code-plan/SKILL.md -> ${target}`);
  } catch (err) {
    console.error(`❌ Failed to read symlink: ${err.message}`);
    errors++;
  }
}

// 3. Check Templates
const requiredTemplates = [
  'implementation-plan-template.md',
  'spike-report-template.md',
  'systematic-debugging-log-template.md',
  'verification-checklist-template.md'
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
import { execSync } from 'child_process';
import os from 'os';

const mmdcPath = path.join(rootDir, 'node_modules', '.bin', 'mmdc');
const mmdcAvailable = fs.existsSync(mmdcPath) ||
  (() => { try { execSync('mmdc --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

if (!mmdcAvailable) {
  console.warn('⚠️  mmdc not found — skipping mermaid block validation. Run: npm install');
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
      try {
        execSync(`"${mmdc}" --input "${tmpIn}" --output "${tmpOut}"`, { stdio: 'pipe' });
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
