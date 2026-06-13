import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { makeResolvePathToFile } from '../../../src/relations/resolve-path.js';

// Unit coverage for the production resolvePathToFile dispatcher: it must route
// TS-family languages through resolveTsPath against on-disk files, and return
// undefined for every other (symbol-resolved or not-yet-implemented) language.

describe('makeResolvePathToFile', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'resolve-path-'));
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'b', 'bar.ts'), 'export const bar = 1;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a relative TypeScript import against a file on disk', () => {
    const resolve = makeResolvePathToFile(root);
    // NodeNext '.js' specifier rewrites to the '.ts' source that exists on disk.
    expect(resolve('../b/bar.js', 'src/a/foo.ts', 'typescript')).toBe('src/b/bar.ts');
  });

  it('dispatches tsx and javascript through the same TS resolver', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../b/bar.js', 'src/a/foo.tsx', 'tsx')).toBe('src/b/bar.ts');
    expect(resolve('../b/bar.js', 'src/a/foo.js', 'javascript')).toBe('src/b/bar.ts');
  });

  it('returns undefined when the resolved file does not exist on disk', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../b/missing.js', 'src/a/foo.ts', 'typescript')).toBeUndefined();
  });

  it('returns undefined for a bare/external specifier', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('zod', 'src/a/foo.ts', 'typescript')).toBeUndefined();
  });

  it('returns undefined for a non-TS language (symbol-resolved or not yet implemented)', () => {
    const resolve = makeResolvePathToFile(root);
    // Even a specifier that would resolve under TS is ignored for other languages.
    expect(resolve('../b/bar.js', 'src/a/foo.py', 'python')).toBeUndefined();
    expect(resolve('../b/bar.js', 'src/a/foo.go', 'go')).toBeUndefined();
    expect(resolve('../b/bar.js', 'src/a/foo.x', '')).toBeUndefined();
  });
});
