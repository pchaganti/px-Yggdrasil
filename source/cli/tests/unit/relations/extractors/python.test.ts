import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { pythonExtractor } from '../../../../src/relations/extractors/python.js';

const run = (code: string) => runExtractor(pythonExtractor, 'python', '.py', code);

const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.targetHint.kind === 'path' ? [u.targetHint.specifier] : []));

describe('python extractor — uses()', () => {
  it('detects a plain `import a.b` as the dotted module hint', async () => {
    const { uses } = await run('import foo.bar');
    expect(uses).toContainEqual(
      expect.objectContaining({ targetHint: { kind: 'path', specifier: 'foo.bar' }, kind: 'import' }),
    );
  });

  it('uses the real module of `import x as y`, never the alias', async () => {
    const { uses } = await run('import numpy as np');
    const s = specs(uses);
    expect(s).toContain('numpy');
    expect(s).not.toContain('np');
  });

  it('detects multiple modules in one `import a, b.c`', async () => {
    const { uses } = await run('import a, b.c');
    const s = specs(uses);
    expect(s).toContain('a');
    expect(s).toContain('b.c');
  });

  it('emits the module (and submodule candidate) for `from a.b import c`', async () => {
    const { uses } = await run('from a.b import c');
    const s = specs(uses);
    expect(s).toContain('a.b'); // the package/module edge
    expect(s).toContain('a.b.c'); // longest-match submodule candidate
  });

  it('uses the real symbol of `from a.b import c as d`, never the alias', async () => {
    const { uses } = await run('from a.b import c as d');
    const s = specs(uses);
    expect(s).toContain('a.b');
    expect(s).toContain('a.b.c');
    expect(s).not.toContain('a.b.d');
  });

  it('encodes relative imports with their leading dots', async () => {
    const { uses } = await run('from ..pkg import m');
    const s = specs(uses);
    expect(s).toContain('..pkg'); // the relative module
    expect(s).toContain('..pkg.m'); // submodule candidate
  });

  it('encodes `from . import sibling` as `.sibling`', async () => {
    const { uses } = await run('from . import sibling');
    const s = specs(uses);
    expect(s).toContain('.sibling');
  });

  it('encodes `from ..pkg.mod import y` as the dotted relative path', async () => {
    const { uses } = await run('from ..pkg.mod import y');
    const s = specs(uses);
    expect(s).toContain('..pkg.mod');
  });

  it('emits NOTHING for `from __future__ import annotations`', async () => {
    const { uses } = await run('from __future__ import annotations');
    expect(uses).toHaveLength(0);
  });

  it('emits ONE hint for the module on `from pkg import *` (no symbol enumeration)', async () => {
    const { uses } = await run('from pkg import *');
    const s = specs(uses);
    expect(s).toContain('pkg');
    // No `pkg.*` or enumerated-symbol candidates.
    expect(s.every((x) => !x.includes('*'))).toBe(true);
  });
});

describe('python extractor — declarations()', () => {
  it('returns top-level class and function names', async () => {
    const { declarations } = await run('class Foo:\n    pass\n\ndef bar():\n    pass\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Foo');
    expect(keys).toContain('bar');
  });

  it('includes a decorated top-level function', async () => {
    const { declarations } = await run('@deco\ndef baz():\n    pass\n');
    expect(declarations.map((d) => d.symbolKey)).toContain('baz');
  });

  it('does NOT return nested (method / inner) definitions', async () => {
    const { declarations } = await run('class Outer:\n    def method(self):\n        pass\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Outer');
    expect(keys).not.toContain('method');
  });
});
