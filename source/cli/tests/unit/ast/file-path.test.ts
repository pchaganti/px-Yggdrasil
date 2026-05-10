import { describe, it, expect } from 'vitest';
import { inFile } from '../../../src/ast/file-path.js';

describe('ast.inFile', () => {
  const file = (p: string): any => ({ path: p, content: '', ast: null as any });

  it('matches glob with **', () => {
    expect(inFile(file('src/handlers/foo.ts'), '**/handlers/*.ts')).toBe(true);
    expect(inFile(file('src/services/foo.ts'), '**/handlers/*.ts')).toBe(false);
  });

  it('matches regex', () => {
    expect(inFile(file('src/foo.test.ts'), /\.test\.ts$/)).toBe(true);
    expect(inFile(file('src/foo.ts'), /\.test\.ts$/)).toBe(false);
  });

  it('matches plain string as substring', () => {
    expect(inFile(file('src/handlers/foo.ts'), '/handlers/')).toBe(true);
    expect(inFile(file('src/services/foo.ts'), '/handlers/')).toBe(false);
  });
});
