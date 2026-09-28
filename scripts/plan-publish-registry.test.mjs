// scripts/plan-publish-registry.test.mjs
//
// Guards for the plan-publishing registry. The registry is the only thing that
// decides which project owns a plan file and where its vault copy lands, so a
// silent misroute files a plan into the wrong Obsidian folder and there is no
// error to notice.
//
// Every fixture here is built inline (temp dirs or plain objects) on purpose:
// the tests must not depend on whether the real Snipset / ram-audit /
// ai-skills checkouts happen to exist on the machine running them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadRegistry,
  resolveProject,
  enumeratePlans,
  destPathFor,
} from './plan-publish-registry.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VAULT = '/home/belajarcarabelajar/Dokumen/Obsidian Vault';

// Build a registry of the shape loadRegistry() returns, with every project root
// under a fresh temp directory. `rootRel` is relative to that temp base, so
// nested roots can be expressed without depending on the base before it exists.
//
// spec: [{ name, rootRel, mirror, plans: ['a.md'] }]   plans: undefined means
// "do not create docs/code-plan/plans at all".
function fixture(tag, spec) {
  const base = mkdtempSync(path.join(tmpdir(), `plan-publish-${tag}-`));
  const projects = spec.map(({ name, rootRel, mirror, plans }) => {
    const root = path.join(base, rootRel);
    if (plans) {
      const dir = path.join(root, 'docs', 'code-plan', 'plans');
      mkdirSync(dir, { recursive: true });
      for (const f of plans) writeFileSync(path.join(dir, f), `# plan ${f}\n`, 'utf8');
    }
    return { name, root, mirror, base, plansDir: path.join(root, 'docs', 'code-plan', 'plans') };
  });
  return {
    base,
    projects,
    registry: {
      vault: VAULT,
      destDirTemplate: '01 - Projects/{project}/plans',
      indexTemplate: '01 - Projects/{project}/index.md',
      stageInVault: true,
      projects: projects.map(({ name, root, mirror }) => ({ name, root, mirror })),
    },
  };
}

function cleanup(f) {
  rmSync(f.base, { recursive: true, force: true });
}

function tmpFile(tag, filename, body) {
  const dir = mkdtempSync(path.join(tmpdir(), `plan-publish-${tag}-`));
  const p = path.join(dir, filename);
  writeFileSync(p, body, 'utf8');
  return { dir, path: p };
}

// ---------- loadRegistry ----------

test('loadRegistry throws and names the path when the config file is absent', () => {
  const missing = path.join(mkdtempSync(path.join(tmpdir(), 'plan-publish-missing-')), 'plans.publish.json');
  assert.throws(
    () => loadRegistry(missing),
    (e) => e instanceof Error && e.message.includes(missing),
    'error message must name the missing config path',
  );
});

test('loadRegistry reads the repo config, whichever projects it lists today', () => {
  const r = loadRegistry();
  assert.equal(r.vault, VAULT);
  assert.equal(r.destDirTemplate, '01 - Projects/{project}/plans');
  assert.equal(r.indexTemplate, '01 - Projects/{project}/index.md');
  assert.equal(r.stageInVault, true);
  // The project LIST is compared against plans.publish.json rather than against
  // a literal. This test guards the parser; a hardcoded list guarded nothing but
  // the day someone added a project, which is exactly what happened when
  // Snipset-seo and dawnbook were registered and this assertion went stale.
  //
  // Reading the same file still proves the file was read: a registry built from
  // defaults would not carry these names, and a config emptied to `projects: []`
  // fails the length check rather than passing quietly.
  const raw = JSON.parse(readFileSync(path.join(rootDir, 'plans.publish.json'), 'utf8'));
  assert.deepEqual(
    r.projects.map((p) => p.name),
    raw.projects.map((p) => p.name),
  );
  assert.ok(
    r.projects.length >= 4,
    `the real registry must still list its projects, got ${r.projects.length}`,
  );
  // The vault's own entry is the reason the mirror flag exists at all.
  assert.equal(r.projects.find((p) => p.name === 'vault').mirror, false);
  assert.equal(r.vault, r.projects.find((p) => p.name === 'vault').root);
});

test('loadRegistry rejects a config missing vault, destDirTemplate, or projects', () => {
  for (const field of ['vault', 'destDirTemplate', 'projects']) {
    const doc = { vault: VAULT, destDirTemplate: 'x/{project}', projects: [] };
    delete doc[field];
    const f = tmpFile('fields', `${field}.json`, JSON.stringify(doc));
    assert.throws(
      () => loadRegistry(f.path),
      (e) => e instanceof Error && e.message.includes(field),
      `config without "${field}" must throw naming the field`,
    );
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('loadRegistry rejects duplicate project names and duplicate roots', () => {
  const dupName = tmpFile('dup-name', 'c.json', JSON.stringify({
    vault: VAULT,
    destDirTemplate: '01 - Projects/{project}/plans',
    projects: [
      { name: 'a', root: '/tmp/a', mirror: true },
      { name: 'a', root: '/tmp/b', mirror: true },
    ],
  }));
  assert.throws(() => loadRegistry(dupName.path), (e) => e instanceof Error && /name/i.test(e.message));

  const dupRoot = tmpFile('dup-root', 'c.json', JSON.stringify({
    vault: VAULT,
    destDirTemplate: '01 - Projects/{project}/plans',
    projects: [
      { name: 'a', root: '/tmp/same', mirror: true },
      { name: 'b', root: '/tmp/same', mirror: true },
    ],
  }));
  assert.throws(() => loadRegistry(dupRoot.path), (e) => e instanceof Error && /root/i.test(e.message));

  rmSync(dupName.dir, { recursive: true, force: true });
  rmSync(dupRoot.dir, { recursive: true, force: true });
});

test('loadRegistry rejects unparseable JSON instead of returning garbage', () => {
  const f = tmpFile('badjson', 'plans.publish.json', '{ not json');
  assert.throws(() => loadRegistry(f.path), (e) => e instanceof Error);
  rmSync(f.dir, { recursive: true, force: true });
});

// ---------- resolveProject ----------

test('resolveProject picks the longest matching root so nested roots stay specific', () => {
  const f = fixture('nested', [
    { name: 'outer', rootRel: 'outer', mirror: true },
    { name: 'inner', rootRel: 'outer/inner', mirror: true },
  ]);
  const inner = resolveProject(f.registry, path.join(f.projects[1].root, 'docs', 'code-plan', 'plans', 'x.md'));
  assert.equal(inner.name, 'inner');
  const outer = resolveProject(f.registry, path.join(f.projects[0].root, 'docs', 'code-plan', 'plans', 'x.md'));
  assert.equal(outer.name, 'outer');
  cleanup(f);
});

test('resolveProject does not match a sibling root that merely shares a string prefix', () => {
  const f = fixture('prefix', [{ name: 'snip', rootRel: 'snip', mirror: true }]);
  const lookalike = path.join(f.base, 'snipset-2', 'docs', 'code-plan', 'plans', 'x.md');
  assert.throws(
    () => resolveProject(f.registry, lookalike),
    (e) => e instanceof Error && e.message.includes('snipset-2'),
    'a root must match on path segments, not on raw string prefixes',
  );
  cleanup(f);
});

test('resolveProject throws naming the plan path when no project matches', () => {
  const f = fixture('unknown', [{ name: 'snip', rootRel: 'snip', mirror: true }]);
  const orphan = path.join(f.base, 'elsewhere', 'docs', 'code-plan', 'plans', 'orphan.md');
  assert.throws(
    () => resolveProject(f.registry, orphan),
    (e) => e instanceof Error && e.message.includes(orphan),
    'error message must name the plan path that could not be routed',
  );
  cleanup(f);
});

test('resolveProject routes a real repo plan to the ai-skills project', () => {
  const registry = loadRegistry();
  const p = resolveProject(registry, path.join(rootDir, 'docs', 'code-plan', 'plans', '2026-09-26-plan-publish-to-obsidian.md'));
  assert.equal(p.name, 'ai-skills');
});

// ---------- enumeratePlans ----------

test('enumeratePlans excludes a mirror:false project entirely', () => {
  const f = fixture('mirror', [
    { name: 'live', rootRel: 'live', mirror: true, plans: ['a.md', 'b.md'] },
    { name: 'already-in-vault', rootRel: 'vaultish', mirror: false, plans: ['c.md'] },
  ]);
  const found = enumeratePlans(f.registry);
  assert.deepEqual(found.map((p) => path.basename(p)).sort(), ['a.md', 'b.md'],
    'mirror:false plans must never be enumerated');
  assert.equal(
    found.every((p) => p.startsWith(f.projects[0].plansDir)),
    true,
    'only the mirror:true project may contribute plans',
  );
  cleanup(f);
});

test('enumeratePlans yields an empty list for a project with no plans directory', () => {
  const f = fixture('nodir', [{ name: 'empty', rootRel: 'empty', mirror: true }]);
  assert.deepEqual(enumeratePlans(f.registry), []);
  cleanup(f);
});

test('enumeratePlans ignores non-markdown files in the plans directory', () => {
  const f = fixture('nonmd', [{ name: 'p', rootRel: 'p', mirror: true, plans: ['real.md'] }]);
  writeFileSync(path.join(f.projects[0].plansDir, 'notes.txt'), 'ignore me', 'utf8');
  assert.deepEqual(enumeratePlans(f.registry).map((p) => path.basename(p)), ['real.md']);
  cleanup(f);
});

// ---------- destPathFor ----------

test('destPathFor places a plan under 01 - Projects/Snipset/plans/ inside the vault', () => {
  const f = fixture('dest', [{ name: 'Snipset', rootRel: 'Snipset', mirror: true }]);
  const plan = '/home/belajarcarabelajar/Proyek/Snipset/docs/code-plan/plans/2026-09-26-example.md';
  const dest = destPathFor(f.registry, { name: 'Snipset' }, plan);
  assert.ok(dest.includes('01 - Projects/Snipset/plans/'), `got ${dest}`);
  assert.equal(dest, path.join(VAULT, '01 - Projects', 'Snipset', 'plans', '2026-09-26-example.md'));
  assert.ok(dest.startsWith(`${VAULT}${path.sep}`), 'destination must stay inside the vault');
  cleanup(f);
});

test('destPathFor keeps the space in the vault path intact', () => {
  const registry = loadRegistry();
  const dest = destPathFor(registry, { name: 'ram-audit' }, '/home/belajarcarabelajar/ram-audit/docs/code-plan/plans/p.md');
  assert.equal(dest.includes('Obsidian Vault'), true);
  assert.equal(dest, `${VAULT}/01 - Projects/ram-audit/plans/p.md`);
});
