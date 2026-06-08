import { describe, it, expect } from 'vitest';
import { normalizeRoot, matchesRoot, partitionByCoverageTier } from '../../../src/core/check.js';

describe('normalizeRoot', () => {
  it('maps "/" to empty string and strips slashes', () => {
    expect(normalizeRoot('/')).toBe('');
    expect(normalizeRoot('/services/')).toBe('services');
    expect(normalizeRoot('services')).toBe('services');
  });
});

describe('matchesRoot', () => {
  it('empty root (whole repo) matches every file', () => {
    expect(matchesRoot('src/a.ts', '')).toBe(true);
  });
  it('matches exact and under-directory, not siblings', () => {
    expect(matchesRoot('services', 'services')).toBe(true);
    expect(matchesRoot('services/a.ts', 'services')).toBe(true);
    expect(matchesRoot('services2/a.ts', 'services')).toBe(false);
  });
});

describe('partitionByCoverageTier', () => {
  it('default whole-repo required → all files are required (error tier)', () => {
    const r = partitionByCoverageTier(['src/a.ts', 'lib/b.ts'], { required: ['/'], excluded: [] });
    expect(r.required.sort()).toEqual(['lib/b.ts', 'src/a.ts']);
    expect(r.middle).toEqual([]);
  });
  it('files outside required fall to middle (warning), excluded are dropped', () => {
    const r = partitionByCoverageTier(
      ['services/a.ts', 'lib/b.ts', 'vendor/c.ts'],
      { required: ['services/'], excluded: ['vendor/'] },
    );
    expect(r.required).toEqual(['services/a.ts']);
    expect(r.middle).toEqual(['lib/b.ts']);
  });
  it('longest match wins; excluded wins an equal-length tie', () => {
    const r = partitionByCoverageTier(
      ['services/legacy/x.ts', 'services/a.ts'],
      { required: ['services/'], excluded: ['services/legacy/'] },
    );
    expect(r.required).toEqual(['services/a.ts']);
    expect(r.middle).toEqual([]);
  });
});
