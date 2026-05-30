import { describe, it, expect } from 'vitest';
import { isPathInMapping, normalizeMappingPath } from '../../../src/structure/expand-mapping-sync.js';

describe('normalizeMappingPath', () => {
  it('strips trailing slash + converts backslash', () => {
    expect(normalizeMappingPath('src\\foo/')).toBe('src/foo');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeMappingPath('')).toBe('');
  });
  it('strips a leading ./ so it matches the fs-gate normalizer', () => {
    expect(normalizeMappingPath('./src/a.ts')).toBe('src/a.ts');
  });
});

describe('isPathInMapping', () => {
  it('matches exact file', () => {
    expect(isPathInMapping('src/a.ts', ['src/a.ts'])).toBe(true);
  });
  it('matches descendant of mapped dir', () => {
    expect(isPathInMapping('src/lib/b.ts', ['src/lib'])).toBe(true);
  });
  it('does NOT match sibling', () => {
    expect(isPathInMapping('src/other.ts', ['src/lib'])).toBe(false);
  });
  it('handles trailing slash on mapping entry', () => {
    expect(isPathInMapping('src/lib/b.ts', ['src/lib/'])).toBe(true);
  });
  it('ignores empty entries', () => {
    expect(isPathInMapping('src/a.ts', ['', 'src/a.ts'])).toBe(true);
  });
});
