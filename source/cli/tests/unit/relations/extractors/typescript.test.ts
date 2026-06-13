import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { typescriptExtractor } from '../../../../src/relations/extractors/typescript.js';

const run = (code: string, ext = '.ts', lang = 'typescript') =>
  runExtractor(typescriptExtractor, lang, ext, code);

describe('typescript extractor — uses()', () => {
  it('detects relative ESM imports as path hints', async () => {
    const { uses } = await run(`import { svc } from './svc';\nimport * as u from '../util/u';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ targetHint: { kind: 'path', specifier: './svc' }, kind: 'import' }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ targetHint: { kind: 'path', specifier: '../util/u' } }),
    );
  });
  it('ignores bare specifiers (external packages / node builtins)', async () => {
    const { uses } = await run(`import path from 'node:path';\nimport { z } from 'zod';`);
    expect(uses).toHaveLength(0);
  });
  it('excludes whole-statement import type', async () => {
    const { uses } = await run(`import type { T } from './t';\nimport { a } from './ab';`);
    expect(uses.some((u) => u.targetHint.kind === 'path' && u.targetHint.specifier === './t')).toBe(
      false,
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ targetHint: { kind: 'path', specifier: './ab' } }),
    );
  });
  it('detects re-exports with a source (not local exports)', async () => {
    const { uses } = await run(
      `export { re } from './reexp';\nexport * from './star';\nexport const local = 1;`,
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ targetHint: { kind: 'path', specifier: './reexp' } }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ targetHint: { kind: 'path', specifier: './star' } }),
    );
    expect(uses).toHaveLength(2);
  });
  it('detects require() and import-equals-require', async () => {
    const { uses } = await run(`const a = require('./a');\nimport b = require('./b');`);
    expect(uses).toContainEqual(
      expect.objectContaining({ targetHint: { kind: 'path', specifier: './a' } }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ targetHint: { kind: 'path', specifier: './b' } }),
    );
  });
  it('detects literal dynamic import, skips non-literal', async () => {
    const { uses } = await run(
      "const d = import('./d');\nconst e = import(`./x-${v}`);\nconst f = import(v);",
    );
    expect(uses.filter((u) => u.targetHint.kind === 'path')).toHaveLength(1);
    expect(uses[0].targetHint).toEqual({ kind: 'path', specifier: './d' });
  });
  it('javascript: detects require + import, no crash on no-type-syntax', async () => {
    const { uses } = await run(`import x from './x';\nconst y = require('./y');`, '.js', 'javascript');
    expect(uses).toHaveLength(2);
  });
});

describe('typescript extractor — declarations()', () => {
  it('returns top-level class/interface/function names', async () => {
    const { declarations } = await run(`export class Foo {}\ninterface Bar {}\nfunction baz(){}`);
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Foo');
    expect(keys).toContain('Bar');
    expect(keys).toContain('baz');
  });
});
