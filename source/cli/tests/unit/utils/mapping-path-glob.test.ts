import { describe, it, expect } from 'vitest';
import { isGlobPattern, mappingEntryMatchesFile } from '../../../src/utils/mapping-path.js';

describe('isGlobPattern', () => {
  it('returns true for * wildcard', () => {
    expect(isGlobPattern('src/*Repository.cs')).toBe(true);
  });
  it('returns true for ** wildcard', () => {
    expect(isGlobPattern('src/**/*.ts')).toBe(true);
  });
  it('returns true for ? wildcard', () => {
    expect(isGlobPattern('src/a?.ts')).toBe(true);
  });
  it('returns true for bracket pattern', () => {
    expect(isGlobPattern('src/[abc].ts')).toBe(true);
  });
  it('returns true for brace pattern', () => {
    expect(isGlobPattern('src/{a,b}.ts')).toBe(true);
  });
  it('returns false for plain file path', () => {
    expect(isGlobPattern('src/index.ts')).toBe(false);
  });
  it('returns false for plain directory path', () => {
    expect(isGlobPattern('src/handlers')).toBe(false);
  });
  it('returns false for empty string', () => {
    expect(isGlobPattern('')).toBe(false);
  });
});

describe('mappingEntryMatchesFile — glob entries', () => {
  it('matches a file matching the single-segment * glob', () => {
    expect(mappingEntryMatchesFile('Source/Database/*Repository.cs', 'Source/Database/FooRepository.cs')).toBe(true);
  });

  it('does NOT match a file that does not satisfy the * glob', () => {
    expect(mappingEntryMatchesFile('Source/Database/*Repository.cs', 'Source/Database/Helper.cs')).toBe(false);
  });

  it('* does not cross path separators', () => {
    // *Repository.cs should NOT match a file in a subdirectory
    expect(mappingEntryMatchesFile('Source/Database/*Repository.cs', 'Source/Database/sub/FooRepository.cs')).toBe(false);
  });

  it('** crosses path separators', () => {
    expect(mappingEntryMatchesFile('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(mappingEntryMatchesFile('src/**/*.ts', 'src/index.ts')).toBe(true);
  });

  it('** does not match a file in a different root', () => {
    expect(mappingEntryMatchesFile('src/**/*.ts', 'lib/index.ts')).toBe(false);
  });

  it('respects dot files with { dot: true }', () => {
    expect(mappingEntryMatchesFile('src/**/*.ts', 'src/.hidden/file.ts')).toBe(true);
  });

  it('empty entry returns false even for a glob-like argument', () => {
    expect(mappingEntryMatchesFile('', 'src/a.ts')).toBe(false);
  });
});

describe('mappingEntryMatchesFile — plain entries (backward compat)', () => {
  it('exact file match returns true', () => {
    expect(mappingEntryMatchesFile('src/index.ts', 'src/index.ts')).toBe(true);
  });

  it('directory prefix match returns true for child file', () => {
    expect(mappingEntryMatchesFile('src/handlers', 'src/handlers/order.ts')).toBe(true);
  });

  it('directory prefix match returns true for deeply nested file', () => {
    expect(mappingEntryMatchesFile('src', 'src/a/b/c.ts')).toBe(true);
  });

  it('different path does not match', () => {
    expect(mappingEntryMatchesFile('src/handlers', 'lib/util.ts')).toBe(false);
  });

  it('partial prefix that is not a directory boundary does not match', () => {
    // 'src/handle' should NOT match 'src/handlers/order.ts'
    expect(mappingEntryMatchesFile('src/handle', 'src/handlers/order.ts')).toBe(false);
  });

  it('empty entry returns false', () => {
    expect(mappingEntryMatchesFile('', 'src/a.ts')).toBe(false);
  });

  it('normalizes leading ./ in entry', () => {
    expect(mappingEntryMatchesFile('./src/index.ts', 'src/index.ts')).toBe(true);
  });

  it('normalizes leading ./ in file', () => {
    expect(mappingEntryMatchesFile('src/index.ts', './src/index.ts')).toBe(true);
  });
});
