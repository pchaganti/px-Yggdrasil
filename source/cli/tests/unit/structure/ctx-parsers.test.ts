import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCtxParsers, prewarmupAstCache } from '../../../src/structure/ctx-parsers.js';

describe('ctx parsers', () => {
  let root: string;
  let touched: string[];
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'yg-ctx-parsers-')); touched = []; });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('parseYaml on File entry', () => {
    const p = createCtxParsers({ projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(p.parseYaml({ path: 'x.yaml', content: 'foo: bar' })).toEqual({ foo: 'bar' });
    expect(touched).toContain('x.yaml');
  });

  it('parseJson on File entry', () => {
    const p = createCtxParsers({ projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(p.parseJson({ path: 'x.json', content: '{"a":1}' })).toEqual({ a: 1 });
  });

  it('parseToml on File entry', () => {
    const p = createCtxParsers({ projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(p.parseToml({ path: 'x.toml', content: 'name = "yg"' })).toEqual({ name: 'yg' });
  });

  it('parseAst on File entry returns tree-sitter Tree synchronously from prewarmed cache', async () => {
    const astCache = new Map();
    const { parseFile } = await import('../../../src/ast/parser.js');
    const tree = await parseFile('x.ts', 'const x = 1;');
    astCache.set('x.ts', { content: 'const x = 1;', ast: tree });

    const p = createCtxParsers({ projectRoot: root, touchedFiles: touched, astCache });
    const got = p.parseAst({ path: 'x.ts', content: 'const x = 1;' }, 'typescript');
    expect((got as any).rootNode).toBeDefined();
  });

  it('parseAst throws structure-aspect-parseast-not-prewarmed on cache miss', () => {
    const p = createCtxParsers({ projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(() => p.parseAst({ path: 'unknown.ts', content: 'x' }, 'typescript'))
      .toThrow(/structure-aspect-parseast-not-prewarmed/);
  });

  it('parser accepts path string and reads + tracks', () => {
    writeFileSync(path.join(root, 'cfg.json'), '{"k":2}');
    const p = createCtxParsers({ projectRoot: root, touchedFiles: touched, astCache: new Map() });
    expect(p.parseJson('cfg.json')).toEqual({ k: 2 });
    expect(touched).toContain('cfg.json');
  });
});

describe('prewarmupAstCache', () => {
  it('populates astCache for TS files and skips non-AST files', async () => {
    const astCache = new Map();
    const files = [
      { path: 'a.ts', content: 'const a = 1;' },
      { path: 'b.yaml', content: 'foo: bar' },
    ];
    await prewarmupAstCache({ astCache, projectRoot: '/tmp', files });
    expect(astCache.has('a.ts')).toBe(true);
    expect(astCache.get('a.ts')!.content).toBe('const a = 1;');
    expect(astCache.has('b.yaml')).toBe(false);
  });

  it('skips re-parsing when cache entry matches content', async () => {
    const astCache = new Map();
    const files = [{ path: 'x.ts', content: 'const x = 1;' }];
    await prewarmupAstCache({ astCache, projectRoot: '/tmp', files });
    const first = astCache.get('x.ts');
    // Run again — should reuse existing cache entry (same object reference)
    await prewarmupAstCache({ astCache, projectRoot: '/tmp', files });
    expect(astCache.get('x.ts')).toBe(first);
  });
});
