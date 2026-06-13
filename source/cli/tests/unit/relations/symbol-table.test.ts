import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SymbolTable, writeSymbolIndex, loadSymbolIndex } from '../../../src/relations/symbol-table.js';

describe('SymbolTable', () => {
  it('resolves a uniquely-defined symbol to its file', () => {
    const t = new SymbolTable(); t.declare('Foo.Bar', 'src/a.cs');
    expect(t.resolveUnique('Foo.Bar')).toBe('src/a.cs');
  });
  it('returns undefined for an ambiguous symbol (two defs, incl. off-graph)', () => {
    const t = new SymbolTable(); t.declare('Foo.Bar', 'src/a.cs'); t.declare('Foo.Bar', 'vendor/b.cs');
    expect(t.resolveUnique('Foo.Bar')).toBeUndefined();
  });
  it('returns undefined for an unknown symbol', () => {
    expect(new SymbolTable().resolveUnique('Nope')).toBeUndefined();
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
});
