import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { typescriptExtractor } from '../../../../src/relations/extractors/typescript.js';

const run = (code: string, ext = '.ts', lang = 'typescript') =>
  runExtractor(typescriptExtractor, lang, ext, code);

describe('typescript extractor — uses()', () => {
  it('detects relative ESM imports as path hints', async () => {
    const { uses } = await run(`import { svc } from './svc';\nimport * as u from '../util/u';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './svc' }], kind: 'import' }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: '../util/u' }] }),
    );
  });
  it('ignores bare specifiers (external packages / node builtins)', async () => {
    const { uses } = await run(`import path from 'node:path';\nimport { z } from 'zod';`);
    expect(uses).toHaveLength(0);
  });
  it('excludes whole-statement import type', async () => {
    const { uses } = await run(`import type { T } from './t';\nimport { a } from './ab';`);
    expect(uses.some((u) => u.candidates[0].kind === 'path' && u.candidates[0].specifier === './t')).toBe(
      false,
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './ab' }] }),
    );
  });
  it('detects re-exports with a source (not local exports)', async () => {
    const { uses } = await run(
      `export { re } from './reexp';\nexport * from './star';\nexport const local = 1;`,
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './reexp' }] }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './star' }] }),
    );
    expect(uses).toHaveLength(2);
  });
  it('detects require() and import-equals-require', async () => {
    const { uses } = await run(`const a = require('./a');\nimport b = require('./b');`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './a' }] }),
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './b' }] }),
    );
  });
  it('detects literal dynamic import, skips non-literal', async () => {
    const { uses } = await run(
      "const d = import('./d');\nconst e = import(`./x-${v}`);\nconst f = import(v);",
    );
    expect(uses.filter((u) => u.candidates[0].kind === 'path')).toHaveLength(1);
    expect(uses[0].candidates[0]).toEqual({ kind: 'path', specifier: './d' });
  });
  it('javascript: detects require + import, no crash on no-type-syntax', async () => {
    const { uses } = await run(`import x from './x';\nconst y = require('./y');`, '.js', 'javascript');
    expect(uses).toHaveLength(2);
  });
  it('excludes a whole-statement namespace type import (`import type * as T from ...`)', async () => {
    const { uses } = await run(`import type * as T from './t';\nimport { a } from './ab';`);
    expect(uses.some((u) => u.candidates[0].kind === 'path' && u.candidates[0].specifier === './t')).toBe(
      false,
    );
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './ab' }] }),
    );
  });
  it('keeps an inline-type import that still has a runtime binding (`import { type A, b }`)', async () => {
    // The `type` modifier sits inside the specifier, not as a statement-level token,
    // so the statement is NOT a whole-statement type import and must be kept.
    const { uses } = await run(`import { type A, b } from './m';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './m' }] }),
    );
  });

  it('excludes a whole-statement export type re-export (`export type { X } from`)', async () => {
    // `export type { X } from './m'` carries a statement-level `type` token before the
    // export_clause — a compile-time-only re-export, NOT a runtime dependency.
    const { uses } = await run(`export type { X } from './typeonly';\nexport { v } from './value';`);
    expect(
      uses.some((u) => u.candidates[0].kind === 'path' && u.candidates[0].specifier === './typeonly'),
    ).toBe(false);
    // The value re-export on the next line is unaffected.
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './value' }] }),
    );
  });

  it('excludes an all-inline-type named import (`import { type A, type B } from`)', async () => {
    // Every specifier carries `type`; no default/namespace binding remains at runtime.
    const { uses } = await run(`import { type A, type B } from './alltype';`);
    expect(uses).toHaveLength(0);
  });

  it('excludes an all-inline-type named export (`export { type A, type B } from`)', async () => {
    const { uses } = await run(`export { type A, type B } from './alltype';`);
    expect(uses).toHaveLength(0);
  });

  it('KEEPS a mixed inline-type export re-export (`export { type A, b } from`)', async () => {
    // `b` is a runtime re-export → exactly one edge survives.
    const { uses } = await run(`export { type A, b } from './mixed';`);
    expect(
      uses.filter((u) => u.candidates[0].kind === 'path' && u.candidates[0].specifier === './mixed'),
    ).toHaveLength(1);
  });

  it('KEEPS an all-inline-type import that still has a default binding (`import def, { type A } from`)', async () => {
    // The default `def` is a runtime binding even though every named specifier is type-only.
    const { uses } = await run(`import def, { type A } from './withdefault';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './withdefault' }] }),
    );
  });

  it('KEEPS a namespace export re-export (`export * as ns from`) — never type-only', async () => {
    // `export type * as` is not valid TS; a namespace re-export is always a runtime edge.
    const { uses } = await run(`export * as ns from './ns';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './ns' }] }),
    );
  });

  it('KEEPS an empty re-export clause (`export {} from`) — not provably type-only', async () => {
    // Zero specifiers: not provably a type-only construct, so the edge is conservatively kept.
    const { uses } = await run(`export {} from './empty';`);
    expect(uses).toContainEqual(
      expect.objectContaining({ candidates: [{ kind: 'path', specifier: './empty' }] }),
    );
  });

  it('deduplicates two require() calls for the same module on one line', async () => {
    const { uses } = await run(`const a = require('./a'); const b = require('./a');`);
    expect(
      uses.filter((u) => u.candidates[0].kind === 'path' && u.candidates[0].specifier === './a'),
    ).toHaveLength(1);
  });
  it('ignores ordinary calls and member calls that merely take a string argument', async () => {
    // `foo('./x')` (plain identifier callee, not `require`) and `obj.method('./x')`
    // (member-expression callee) are neither dynamic import nor require → no edge.
    const { uses } = await run(`foo('./x');\nobj.method('./y');`);
    expect(uses).toHaveLength(0);
  });
  it('emits nothing for a dynamic import of the empty string literal', async () => {
    // `import('')` yields an empty specifier (the string node has no string_fragment);
    // the emit guard drops the empty / non-relative specifier.
    const { uses } = await run(`const d = import('');`);
    expect(uses).toHaveLength(0);
  });
  it('emits nothing for a require with no arguments', async () => {
    // `require()` has an empty argument list → firstArgument is null → no edge.
    const { uses } = await run(`const x = require();`);
    expect(uses).toHaveLength(0);
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
  it('does NOT return a class nested inside a function body', async () => {
    const { declarations } = await run(`function outer(){ class Inner {} }`);
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('outer');
    expect(keys).not.toContain('Inner');
  });
  it('does NOT return a class exported inside a namespace block (not program top level)', async () => {
    // The class is wrapped in an export_statement whose parent is the namespace body,
    // not `program` — isTopLevel rejects it via the grandparent check.
    const { declarations } = await run(`namespace N { export class Inner {} }`);
    expect(declarations.map((d) => d.symbolKey)).not.toContain('Inner');
  });
});
