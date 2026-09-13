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
const scripts = ['install.sh', 'scripts/sync.sh'];
for (const scr of scripts) {
  const p = path.join(rootDir, scr);
  if (!fs.existsSync(p)) {
    console.error(`❌ Missing script: ${scr}`);
    errors++;
  } else {
    console.log(`✅ Script present: ${scr}`);
  }
}

if (errors > 0) {
  console.error(`\n❌ Validation failed with ${errors} error(s).`);
  process.exit(1);
} else {
  console.log('\n✅ All validations passed successfully!');
}
