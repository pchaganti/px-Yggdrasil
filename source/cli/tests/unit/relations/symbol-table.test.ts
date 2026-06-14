import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SymbolTable, writeSymbolIndex, loadSymbolIndex } from '../../../src/relations/symbol-table.js';

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

describe('symbol index persistence', () => {
  it('round-trips and detects staleness by builtFrom hash set; atomic (no .tmp left)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-symidx-'));
    try {
      await writeSymbolIndex(dir, 'csharp', { builtFrom: [['src/a.cs', 'h1']], symbols: [['Foo.Bar', 'src/a.cs']] });
      const fresh = loadSymbolIndex(dir, 'csharp', [['src/a.cs', 'h1']]);
      expect(fresh?.symbols).toContainEqual(['Foo.Bar', 'src/a.cs']);
      expect(loadSymbolIndex(dir, 'csharp', [['src/a.cs', 'h2']])).toBeNull(); // content changed → stale
      expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('matches regardless of builtFrom ORDER (canonical sort) but rebuilds on a changed set', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-symidx-'));
    try {
      // Two files; persisted in one order, queried in the reverse order → the
      // canonical builtFrom sort must still report a hit (exercises canonBuiltFrom).
      await writeSymbolIndex(dir, 'csharp', {
        builtFrom: [['src/a.cs', 'h1'], ['src/b.cs', 'h2']],
        symbols: [['A', 'src/a.cs']],
      });
      expect(loadSymbolIndex(dir, 'csharp', [['src/b.cs', 'h2'], ['src/a.cs', 'h1']])).not.toBeNull();
      // A different file set → stale → null.
      expect(loadSymbolIndex(dir, 'csharp', [['src/a.cs', 'h1']])).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns null for a malformed or structurally-invalid index file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-symidx-'));
    try {
      // Non-JSON → JSON.parse throws → null.
      writeFileSync(path.join(dir, 'symbols-csharp.json'), 'not json at all', 'utf-8');
      expect(loadSymbolIndex(dir, 'csharp', [['src/a.cs', 'h1']])).toBeNull();
      // Valid JSON but wrong shape (builtFrom/symbols not arrays) → null.
      writeFileSync(path.join(dir, 'symbols-go.json'), JSON.stringify({ builtFrom: 'x', symbols: 1 }), 'utf-8');
      expect(loadSymbolIndex(dir, 'go', [['src/a.go', 'h1']])).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
