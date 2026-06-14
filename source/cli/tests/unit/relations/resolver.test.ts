import { describe, it, expect } from 'vitest';
import { makeResolver } from '../../../src/relations/resolver.js';
import { SymbolTable } from '../../../src/relations/symbol-table.js';

const owner = { ownerOf: (f: string) => (f === 'src/b.cs' ? 'b' : undefined) };

describe('resolver', () => {
  it('resolves a unique same-language symbol to a mapped owner', () => {
    const st = new SymbolTable(); st.declare('csharp', 'Foo.Bar', 'src/b.cs');
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.resolve({ kind: 'symbol', symbolKey: 'Foo.Bar' }, 'src/a.cs', 'csharp')).toEqual({ ownerNode: 'b', resolvedFile: 'src/b.cs' });
  });
  it('SILENCES a symbol whose only same-name decl is in ANOTHER language', () => {
    // owner.ownerOf maps src/b.cs → 'b'; but the decl is keyed under 'cpp', the use is 'ruby'.
    const st = new SymbolTable(); st.declare('cpp', 'Connection', 'src/b.cs');
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.resolve({ kind: 'symbol', symbolKey: 'Connection' }, 'src/a.rb', 'ruby')).toBeUndefined();
  });
  it('returns undefined for an unmapped symbol target (D7 coverage layering)', () => {
    const st = new SymbolTable(); st.declare('csharp', 'X.Y', 'vendor/x.cs');
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.resolve({ kind: 'symbol', symbolKey: 'X.Y' }, 'src/a.cs', 'csharp')).toBeUndefined();
  });
  it('returns undefined for an ambiguous symbol', () => {
    const st = new SymbolTable(); st.declare('csharp', 'A', 'src/b.cs'); st.declare('csharp', 'A', 'src/c.cs');
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: st, resolvePathToFile: () => undefined });
    expect(r.resolve({ kind: 'symbol', symbolKey: 'A' }, 'src/a.cs', 'csharp')).toBeUndefined();
  });
  it('resolves a path hint via the injected resolver', () => {
    const r = makeResolver({ ownerIndex: owner as any, symbolTable: new SymbolTable(), resolvePathToFile: () => 'src/b.cs' });
    expect(r.resolve({ kind: 'path', specifier: './b' }, 'src/a.cs', 'csharp')).toEqual({ ownerNode: 'b', resolvedFile: 'src/b.cs' });
  });
});
