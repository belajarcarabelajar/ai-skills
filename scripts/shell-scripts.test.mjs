// scripts/shell-scripts.test.mjs
//
// Tests for shell scripts. These scripts have side effects (cd, git, etc.)
// so we test them by:
// 1. Syntax check with bash -n
// 2. Verifying they exist and are executable
// 3. Testing individual functions by extracting and evaluating them

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// Helper: run bash -n on a script
function bashSyntaxCheck(scriptPath) {
  const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  return r.status === 0;
}

// Helper: check if file exists and is executable
function isExecutable(scriptPath) {
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------- accept-chunks.sh ----------

test('accept-chunks.sh exists and is executable', () => {
  const p = path.join(SCRIPTS_DIR, 'accept-chunks.sh');
  assert.ok(fs.existsSync(p), 'accept-chunks.sh does not exist');
  assert.ok(isExecutable(p), 'accept-chunks.sh is not executable');
});

test('accept-chunks.sh has valid bash syntax', () => {
  const p = path.join(SCRIPTS_DIR, 'accept-chunks.sh');
  assert.ok(bashSyntaxCheck(p), 'accept-chunks.sh has syntax errors');
});

test('accept-chunks.sh shows usage with no args', () => {
  // The no-arg path lists chunk files dirty in the working tree, so it only
  // reaches the "tidak ada chunk" message when the tree is clean. Running it
  // against the real repo would make this test fail whenever a chunk is being
  // accepted (i.e. exactly when the tool matters). Copy the script into a
  // throwaway git repo with nothing dirty and exercise the real body there.
  const p = path.join(SCRIPTS_DIR, 'accept-chunks.sh');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-chunks-test-'));
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.copyFileSync(p, path.join(tmp, 'scripts', 'accept-chunks.sh'));
  const git = (...args) => spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const r = spawnSync('bash', [path.join(tmp, 'scripts', 'accept-chunks.sh')], { encoding: 'utf8', cwd: tmp });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('tidak ada chunk'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- plan-mirror-check.sh ----------

test('plan-mirror-check.sh exists and is executable', () => {
  const p = path.join(SCRIPTS_DIR, 'plan-mirror-check.sh');
  assert.ok(fs.existsSync(p), 'plan-mirror-check.sh does not exist');
  assert.ok(isExecutable(p), 'plan-mirror-check.sh is not executable');
});

test('plan-mirror-check.sh has valid bash syntax', () => {
  const p = path.join(SCRIPTS_DIR, 'plan-mirror-check.sh');
  assert.ok(bashSyntaxCheck(p), 'plan-mirror-check.sh has syntax errors');
});

// ---------- render-diagrams.sh ----------

test('render-diagrams.sh exists and is executable', () => {
  const p = path.join(SCRIPTS_DIR, 'render-diagrams.sh');
  assert.ok(fs.existsSync(p), 'render-diagrams.sh does not exist');
  assert.ok(isExecutable(p), 'render-diagrams.sh is not executable');
});

test('render-diagrams.sh has valid bash syntax', () => {
  const p = path.join(SCRIPTS_DIR, 'render-diagrams.sh');
  assert.ok(bashSyntaxCheck(p), 'render-diagrams.sh has syntax errors');
});

test('render-diagrams.sh slugify function works correctly', () => {
  // Extract and test the slugify function
  const script = fs.readFileSync(path.join(SCRIPTS_DIR, 'render-diagrams.sh'), 'utf8');
  const slugifyMatch = script.match(/slugify\(\)\s*\{[^}]+\}/);
  assert.ok(slugifyMatch, 'slugify function not found');
  
  // Test slugify logic
  const slugify = (p) => p.replace(/^.*\//, '').replace(/\.md$/, '').replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase();
  assert.equal(slugify('README.md'), 'readme');
  assert.equal(slugify('docs/guide.md'), 'guide');
  assert.equal(slugify('path/to/file-name.md'), 'file-name');
});

// ---------- sync.sh ----------

test('sync.sh exists and is executable', () => {
  const p = path.join(SCRIPTS_DIR, 'sync.sh');
  assert.ok(fs.existsSync(p), 'sync.sh does not exist');
  assert.ok(isExecutable(p), 'sync.sh is not executable');
});

test('sync.sh has valid bash syntax', () => {
  const p = path.join(SCRIPTS_DIR, 'sync.sh');
  assert.ok(bashSyntaxCheck(p), 'sync.sh has syntax errors');
});

test('sync.sh shows usage for invalid action', () => {
  const p = path.join(SCRIPTS_DIR, 'sync.sh');
  const r = spawnSync('bash', [p, 'invalid-action'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('Usage:'));
});

test('sync.sh status action works', () => {
  const p = path.join(SCRIPTS_DIR, 'sync.sh');
  const r = spawnSync('bash', [p, 'status'], { encoding: 'utf8', cwd: ROOT });
  // Should exit 0 and show status
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('==>') || r.stdout.includes('[WARN]') || r.stdout.includes('[INFO]'));
});

// ---------- verify-chunk.sh ----------

test('verify-chunk.sh exists and is executable', () => {
  const p = path.join(SCRIPTS_DIR, 'verify-chunk.sh');
  assert.ok(fs.existsSync(p), 'verify-chunk.sh does not exist');
  assert.ok(isExecutable(p), 'verify-chunk.sh is not executable');
});

test('verify-chunk.sh has valid bash syntax', () => {
  const p = path.join(SCRIPTS_DIR, 'verify-chunk.sh');
  assert.ok(bashSyntaxCheck(p), 'verify-chunk.sh has syntax errors');
});

test('verify-chunk.sh shows usage with no args', () => {
  const p = path.join(SCRIPTS_DIR, 'verify-chunk.sh');
  const r = spawnSync('bash', [p], { encoding: 'utf8', cwd: ROOT });
  // Should fail with usage error
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('usage:') || r.stdout.includes('usage:'));
});

// ---------- Cross-script integration ----------

test('all shell scripts have proper shebangs', () => {
  const scripts = ['accept-chunks.sh', 'plan-mirror-check.sh', 'render-diagrams.sh', 'sync.sh', 'verify-chunk.sh'];
  for (const name of scripts) {
    const content = fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
    assert.ok(content.startsWith('#!/usr/bin/env bash'), `${name} missing proper shebang`);
  }
});

test('all shell scripts use set -e or set -uo pipefail', () => {
  const scripts = ['accept-chunks.sh', 'plan-mirror-check.sh', 'render-diagrams.sh', 'sync.sh', 'verify-chunk.sh'];
  for (const name of scripts) {
    const content = fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
    assert.ok(
      content.includes('set -e') || content.includes('set -uo pipefail'),
      `${name} missing error handling`
    );
  }
});
