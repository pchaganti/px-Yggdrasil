import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { relationIndexDir } from '../../../src/relations/index-dir.js';

describe('relationIndexDir', () => {
  it('returns .symbols-cache INSIDE the .yggdrasil graph root (not the project root)', () => {
    const graphRoot = path.join('/tmp', 'proj', '.yggdrasil');
    expect(relationIndexDir(graphRoot)).toBe(
      path.join('/tmp', 'proj', '.yggdrasil', '.symbols-cache'),
    );
  });

  it('does NOT return the legacy root-level .yg-cache path', () => {
    const graphRoot = path.join('/tmp', 'proj', '.yggdrasil');
    expect(relationIndexDir(graphRoot)).not.toBe(
      path.join('/tmp', 'proj', '.yg-cache'),
    );
  });
});
