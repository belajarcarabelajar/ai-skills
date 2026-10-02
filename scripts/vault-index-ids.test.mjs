import { test, expect, describe } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIdOwners, searchIds } from './vault-index-ids.mjs';

/** Build a throwaway semantic dir so tests never touch the real corpus. */
function fixture(chunks) {
  const dir = mkdtempSync(join(tmpdir(), 'ids-'));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(chunks)) {
    writeFileSync(join(dir, name), JSON.stringify(body));
  }
  return dir;
}

const NODE = (id) => ({ id, file_type: id.startsWith('rationale--') ? 'rationale' : 'concept' });

describe('loadIdOwners', () => {
  test('maps each id to the chunk that emitted it', () => {
    const dir = fixture({
      'chunk-a.json': { nodes: [NODE('concept--alpha'), NODE('rationale--why')] },
      'chunk-b.json': { nodes: [NODE('concept--beta')] },
    });
    const byId = loadIdOwners(dir);
    expect([...byId.keys()].sort()).toEqual([
      'concept--alpha',
      'concept--beta',
      'rationale--why',
    ]);
    expect([...byId.get('concept--alpha')]).toEqual(['chunk-a.json']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('an id emitted twice lists both owners, which is what reuse looks like', () => {
    const dir = fixture({
      'chunk-a.json': { nodes: [NODE('concept--shared')] },
      'chunk-b.json': { nodes: [NODE('concept--shared')] },
    });
    const byId = loadIdOwners(dir);
    expect([...byId.get('concept--shared')].sort()).toEqual([
      'chunk-a.json',
      'chunk-b.json',
    ]);
    // one entry, two owners -- the graph will union these, so they must agree
    expect(byId.size).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a malformed chunk does not hide every other id', () => {
    const dir = fixture({
      'chunk-good.json': { nodes: [NODE('concept--alpha')] },
    });
    writeFileSync(join(dir, 'chunk-broken.json'), '{ this is not json');
    const byId = loadIdOwners(dir);
    expect(byId.has('concept--alpha')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('non-chunk files and absent dirs are ignored, not fatal', () => {
    const dir = fixture({
      'chunk-a.json': { nodes: [NODE('concept--alpha')] },
      'batches.json': { nodes: [NODE('concept--not-a-chunk')] },
      'notes.md': '# not a chunk',
    });
    const byId = loadIdOwners(dir);
    expect(byId.has('concept--not-a-chunk')).toBe(false);
    expect(byId.size).toBe(1);
    // An empty or missing directory yields an empty map rather than throwing,
    // so a subagent on the very first wave still gets a usable tool.
    expect(loadIdOwners(join(dir, 'does-not-exist')).size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('nodes with a non-string id are skipped rather than poisoning the map', () => {
    const dir = fixture({
      'chunk-a.json': { nodes: [NODE('concept--ok'), { file_type: 'concept' }, null] },
    });
    const byId = loadIdOwners(dir);
    expect([...byId.keys()]).toEqual(['concept--ok']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a chunk with no nodes key does not throw', () => {
    const dir = fixture({ 'chunk-empty.json': {} });
    expect(loadIdOwners(dir).size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('searchIds', () => {
  const byId = new Map([
    ['concept--tgrep-wrapper-false-negatives', new Set(['chunk-a.json'])],
    ['rationale--tgrep-wrapper-mangles-alternation', new Set(['chunk-b.json'])],
    ['concept--youtube-iframe-player-error-153', new Set(['chunk-c.json'])],
  ]);

  test('matches on substring so a bare slug still finds the prefixed id', () => {
    // This is the whole reason this tool exists: searching the slug
    // `tgrep-wrapper-false-negatives` against a prefixed id must still hit.
    const hits = searchIds('tgrep-wrapper-false-negatives', byId);
    expect(hits.map(([id]) => id)).toEqual(['concept--tgrep-wrapper-false-negatives']);
  });

  test('is case-insensitive', () => {
    expect(searchIds('TGrep', byId).length).toBe(2);
    expect(searchIds('YOUTUBE', byId).length).toBe(1);
  });

  test('a miss returns empty, and that is a valid answer', () => {
    expect(searchIds('nothing-emitted-this', byId)).toEqual([]);
  });

  test('results are sorted so output is stable between runs', () => {
    const hits = searchIds('tgrep', byId).map(([id]) => id);
    expect(hits).toEqual([...hits].sort());
  });

  test('each hit carries its owner chunk, so a subagent can read the node', () => {
    const [[, owners]] = searchIds('youtube', byId);
    expect(owners).toEqual(['chunk-c.json']);
  });
});