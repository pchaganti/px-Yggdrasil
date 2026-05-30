import { describe, it, expect } from 'vitest';
import { normalizeMappingPath } from '../../../src/utils/mapping-path.js';

describe('normalizeMappingPath', () => {
  it('strips leading ./', () => {
    expect(normalizeMappingPath('./src/a.ts')).toBe('src/a.ts');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeMappingPath('  src/a.ts  ')).toBe('src/a.ts');
  });
  it('converts backslashes to forward slashes', () => {
    expect(normalizeMappingPath('src\\foo')).toBe('src/foo');
  });
  it('strips trailing slashes', () => {
    expect(normalizeMappingPath('src/foo/')).toBe('src/foo');
  });
  it('combines all rules — trims, converts, strips ./, strips trailing', () => {
    expect(normalizeMappingPath('  ./src\\foo/  ')).toBe('src/foo');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeMappingPath('')).toBe('');
  });
  it('returns empty string for whitespace-only input', () => {
    expect(normalizeMappingPath('   ')).toBe('');
  });
});
