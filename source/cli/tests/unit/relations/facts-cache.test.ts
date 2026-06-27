import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { astCacheDir, factsKey, loadFacts, writeFacts } from '../../../src/relations/facts-cache.js';

describe('facts-cache', () => {
  let dir: string;
  beforeEach(() => { dir = astCacheDir(mkdtempSync(path.join(os.tmpdir(), 'astc-'))); });
  const key = factsKey({ contentHash: 'abc', language: 'typescript', grammarHash: 'g1', rev: 1 });

  it('round-trips facts', async () => {
    await writeFacts(dir, 'typescript', key, { declarations: [], uses: [] });
    expect(await loadFacts(dir, 'typescript', key)).toEqual({ declarations: [], uses: [] });
  });
  it('returns null on miss', async () => {
    expect(await loadFacts(dir, 'typescript', factsKey({ contentHash: 'zzz', language: 'typescript', grammarHash: 'g1', rev: 1 }))).toBeNull();
  });
  it('returns null on a different schema version directory', async () => {
    // a key built with a different rev/grammar must not collide
    expect(await loadFacts(dir, 'typescript', factsKey({ contentHash: 'abc', language: 'typescript', grammarHash: 'g2', rev: 1 }))).toBeNull();
  });
});
