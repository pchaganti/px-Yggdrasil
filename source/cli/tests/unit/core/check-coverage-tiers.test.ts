import { describe, it, expect } from 'vitest';
import { normalizeRoot, matchesRoot, partitionByCoverageTier } from '../../../src/core/check.js';

describe('normalizeRoot', () => {
  it('maps "/" to empty string and strips slashes', () => {
    expect(normalizeRoot('/')).toBe('');
    expect(normalizeRoot('/services/')).toBe('services');
    expect(normalizeRoot('services')).toBe('services');
  });

  it('collapses internal double-slashes', () => {
    // Fix 3: internal slash runs must be collapsed so roots match single-slash git paths
    expect(normalizeRoot('/services//nested/')).toBe('services/nested');
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

  it('Fix 8a: TRUE equal-length tie — file under both required and excluded same length → excluded wins (silent)', () => {
    // required: ['foo/'] and excluded: ['foo/'] — same normalized length ('foo')
    // so excluded wins the tie and foo/x.ts is silent
    const r = partitionByCoverageTier(
      ['foo/x.ts'],
      { required: ['foo/'], excluded: ['foo/'] },
    );
    expect(r.required).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it('Fix 8a: multi-required overlap — longer specific root wins for file under both roots', () => {
    // services/auth/x.ts matches both 'services/' (len 8) and 'services/auth/' (len 13)
    // → longer match ('services/auth/') wins → required tier
    const r = partitionByCoverageTier(
      ['services/auth/x.ts', 'services/billing/y.ts'],
      { required: ['services/', 'services/auth/'], excluded: [] },
    );
    expect(r.required.sort()).toEqual(['services/auth/x.ts', 'services/billing/y.ts']);
    expect(r.middle).toEqual([]);
  });
});
