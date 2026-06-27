import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { astCacheDir } from '../../../src/relations/facts-cache.js';

describe('astCacheDir', () => {
  it('returns .ast-cache INSIDE the .yggdrasil graph root (not the project root)', () => {
    const graphRoot = path.join('/tmp', 'proj', '.yggdrasil');
    expect(astCacheDir(graphRoot)).toBe(
      path.join('/tmp', 'proj', '.yggdrasil', '.ast-cache'),
    );
  });

  it('does NOT return the legacy root-level .yg-cache path', () => {
    const graphRoot = path.join('/tmp', 'proj', '.yggdrasil');
    expect(astCacheDir(graphRoot)).not.toBe(
      path.join('/tmp', 'proj', '.yg-cache'),
    );
  });

  it('does NOT return the retired .symbols-cache path', () => {
    const graphRoot = path.join('/tmp', 'proj', '.yggdrasil');
    expect(astCacheDir(graphRoot)).not.toBe(
      path.join('/tmp', 'proj', '.yggdrasil', '.symbols-cache'),
    );
  });
});
