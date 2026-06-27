import { describe, it, expect } from 'vitest';
import { SymbolTable } from '../../../src/relations/symbol-table.js';

describe('SymbolTable', () => {
  it('resolves a uniquely-defined symbol to its file (same language)', () => {
    const t = new SymbolTable(); t.declare('csharp', 'Foo.Bar', 'src/a.cs');
    expect(t.resolveUnique('csharp', 'Foo.Bar')).toBe('src/a.cs');
  });
  it('returns undefined for an ambiguous symbol within one language (two defs)', () => {
    const t = new SymbolTable();
    t.declare('csharp', 'Foo.Bar', 'src/a.cs'); t.declare('csharp', 'Foo.Bar', 'vendor/b.cs');
    expect(t.resolveUnique('csharp', 'Foo.Bar')).toBeUndefined();
  });
  it('returns undefined for an unknown symbol', () => {
    expect(new SymbolTable().resolveUnique('csharp', 'Nope')).toBeUndefined();
  });
  it('PARTITION: a use in one language does NOT match a same-name decl in another language', () => {
    // The cross-language bare-name FP: C++ `class Connection` must not satisfy a Ruby `Connection`.
    const t = new SymbolTable();
    t.declare('cpp', 'Connection', 'src/net/connection.cpp');
    expect(t.resolveUnique('ruby', 'Connection')).toBeUndefined(); // partitioned → silence
    expect(t.resolveUnique('cpp', 'Connection')).toBe('src/net/connection.cpp'); // same language still resolves
  });
  it('PARTITION: the SAME symbolKey may resolve independently per language', () => {
    const t = new SymbolTable();
    t.declare('ruby', 'Connection', 'src/a/connection.rb');
    t.declare('cpp', 'Connection', 'src/net/connection.cpp');
    expect(t.resolveUnique('ruby', 'Connection')).toBe('src/a/connection.rb');
    expect(t.resolveUnique('cpp', 'Connection')).toBe('src/net/connection.cpp');
  });
});
