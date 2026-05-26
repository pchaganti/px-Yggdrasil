import { describe, it, expect } from 'vitest';
import { inFile } from '../../../src/ast/file-path.js';

const f = (path: string) => ({ path, content: '', ast: null as any });

describe('inFile discriminated pattern', () => {
  it('glob', () => {
    expect(inFile(f('src/foo.ts'), { glob: 'src/**/*.ts' })).toBe(true);
    expect(inFile(f('lib/foo.ts'), { glob: 'src/**/*.ts' })).toBe(false);
  });
  it('regex', () => {
    expect(inFile(f('src/foo.ts'), { regex: /\.ts$/ })).toBe(true);
    expect(inFile(f('src/foo.js'), { regex: /\.ts$/ })).toBe(false);
  });
  it('contains', () => {
    expect(inFile(f('src/api/handler.ts'), { contains: 'api/' })).toBe(true);
    expect(inFile(f('src/db/handler.ts'), { contains: 'api/' })).toBe(false);
  });
  it('unknown pattern returns false', () => {
    expect(inFile(f('src/foo.ts'), {} as any)).toBe(false);
  });
});
