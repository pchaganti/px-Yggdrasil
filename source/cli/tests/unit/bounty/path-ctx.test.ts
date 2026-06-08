import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createCtxFs,
  resolveAllowedReadPath,
  UndeclaredFsReadError,
} from '../../../src/structure/ctx-fs.js';
import { createCtxGraph } from '../../../src/structure/ctx-graph.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { cleanupTestGraphs } from '../helpers/build-test-graph.js';

// ===========================================================================
// PATH CTX BOUNTY SUITE
//
// Surface under test:
//   - ctx-fs: isAllowed (via resolveAllowedReadPath) + the createCtxFs gate
//   - ctx-fs: glob allowed-set entries (matching/non-matching/probe-prefix)
//   - ctx-fs: .. traversal + absolute-path rejection
//   - ctx-graph: toPublicNode with expandedFilesByNode vs raw-mapping fallback
//
// Every test uses a fresh tmp dir and removes it in afterEach. The repo's own
// files are never touched.
// ===========================================================================

// ---------------------------------------------------------------------------
// PART A — resolveAllowedReadPath (pure path/allow-set logic, no fs gate)
// ---------------------------------------------------------------------------
describe('resolveAllowedReadPath — allow-set + lexical guards', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-bounty-rap-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns the normalized repo-relative path for an exact allowed entry', () => {
    const set = new Set(['src/foo.ts']);
    expect(resolveAllowedReadPath('src/foo.ts', set, root)).toBe('src/foo.ts');
  });

  it('strips a leading ./ before allow-set comparison', () => {
    const set = new Set(['src/foo.ts']);
    expect(resolveAllowedReadPath('./src/foo.ts', set, root)).toBe('src/foo.ts');
  });

  it('admits a file under a directory allow-set entry (dir-prefix semantics)', () => {
    const set = new Set(['src/lib']);
    expect(resolveAllowedReadPath('src/lib/baz.ts', set, root)).toBe('src/lib/baz.ts');
  });

  it('admits a deeply nested file under a directory allow-set entry', () => {
    const set = new Set(['src']);
    expect(resolveAllowedReadPath('src/a/b/c/d.ts', set, root)).toBe('src/a/b/c/d.ts');
  });

  it('admits the directory allow-set entry itself (exact match)', () => {
    const set = new Set(['src/lib']);
    expect(resolveAllowedReadPath('src/lib', set, root)).toBe('src/lib');
  });

  it('admits an ancestor directory of an allowed FILE (parent-probe)', () => {
    // 'src' is an ancestor dir of allowed file 'src/lib/baz.ts' → admitted so
    // exists()/list() can walk down to the allowed file.
    const set = new Set(['src/lib/baz.ts']);
    expect(resolveAllowedReadPath('src', set, root)).toBe('src');
    expect(resolveAllowedReadPath('src/lib', set, root)).toBe('src/lib');
  });

  it('rejects a sibling NOT covered by the allow-set', () => {
    const set = new Set(['src/foo.ts']);
    expect(() => resolveAllowedReadPath('src/bar.ts', set, root)).toThrow(UndeclaredFsReadError);
  });

  it('rejects a path whose name is a prefix of an allowed entry but not a dir ancestor', () => {
    // 'src/foo.ts' must NOT admit 'src/foo.ts.bak' — startsWith(p + '/') guards
    // against substring confusion (needs the slash boundary).
    const set = new Set(['src/foo.ts']);
    expect(() => resolveAllowedReadPath('src/foo.ts.bak', set, root)).toThrow(UndeclaredFsReadError);
  });

  it('rejects a directory whose name is a string-prefix of an allowed dir but not an ancestor', () => {
    // 'src/lib' allowed should NOT admit 'src/libextra' (no slash boundary).
    const set = new Set(['src/lib']);
    expect(() => resolveAllowedReadPath('src/libextra', set, root)).toThrow(UndeclaredFsReadError);
  });

  it('rejects the empty string (normalizes to repo root)', () => {
    const set = new Set(['src/foo.ts']);
    expect(() => resolveAllowedReadPath('', set, root)).toThrow(UndeclaredFsReadError);
  });

  it('rejects "." (the repo root itself)', () => {
    const set = new Set(['src/foo.ts']);
    expect(() => resolveAllowedReadPath('.', set, root)).toThrow(UndeclaredFsReadError);
  });

  it('rejects an empty allow-set for any path', () => {
    const set = new Set<string>();
    expect(() => resolveAllowedReadPath('src/foo.ts', set, root)).toThrow(UndeclaredFsReadError);
  });

  // --- absolute paths ------------------------------------------------------
  it('rejects an absolute path outside the repo', () => {
    const set = new Set(['src/foo.ts']);
    expect(() => resolveAllowedReadPath('/etc/passwd', set, root)).toThrow(UndeclaredFsReadError);
  });

  it('an absolute path pointing INTO the repo is normalized to its allowed relative form', () => {
    // path.resolve(root, absInRepo) === absInRepo, then path.relative(root, ...)
    // yields the in-repo relative path. Since that relative form is allow-listed
    // and stays inside the repo, the absolute string is accepted and returned in
    // its canonical repo-relative form. (An absolute path OUTSIDE the repo still
    // produces a '..' relative form and is rejected — covered separately.)
    const set = new Set(['src/foo.ts']);
    const abs = path.join(root, 'src/foo.ts');
    expect(resolveAllowedReadPath(abs, set, root)).toBe('src/foo.ts');
  });

  // --- .. traversal --------------------------------------------------------
  it('rejects a bare ../ that escapes the repo', () => {
    const set = new Set(['src/foo.ts']);
    expect(() => resolveAllowedReadPath('../secret.txt', set, root)).toThrow(UndeclaredFsReadError);
  });

  it('rejects traversal that escapes the repo through an allowed directory prefix', () => {
    const set = new Set(['src/lib']);
    expect(() =>
      resolveAllowedReadPath('src/lib/../../../../../../etc/passwd', set, root),
    ).toThrow(UndeclaredFsReadError);
  });

  it('rejects traversal that lands exactly at the parent of the repo root', () => {
    const set = new Set(['src/lib']);
    expect(() => resolveAllowedReadPath('src/lib/../..', set, root)).toThrow(UndeclaredFsReadError);
  });

  it('accepts an in-repo path that uses .. but stays inside the repo (collapses to allowed)', () => {
    // 'src/lib/../foo.ts' collapses to 'src/foo.ts' which is allowed.
    const set = new Set(['src/foo.ts']);
    expect(resolveAllowedReadPath('src/lib/../foo.ts', set, root)).toBe('src/foo.ts');
  });

  it('rejects an in-repo path that uses .. and collapses to a NON-allowed sibling', () => {
    const set = new Set(['src/foo.ts']);
    // collapses to 'src/bar.ts' — not allowed
    expect(() => resolveAllowedReadPath('src/lib/../bar.ts', set, root)).toThrow(UndeclaredFsReadError);
  });

  // --- glob allow-set entries ---------------------------------------------
  it('admits a file matching a single-segment glob entry', () => {
    const set = new Set(['src/db/*Repository.cs']);
    expect(resolveAllowedReadPath('src/db/OrderRepository.cs', set, root)).toBe('src/db/OrderRepository.cs');
  });

  it('rejects a sibling NOT matching the single-segment glob entry', () => {
    const set = new Set(['src/db/*Repository.cs']);
    expect(() => resolveAllowedReadPath('src/db/Helper.cs', set, root)).toThrow(UndeclaredFsReadError);
  });

  it('single-segment * does NOT cross a path separator', () => {
    // 'src/*.ts' must not match 'src/sub/x.ts' (a single * stays within one segment).
    const set = new Set(['src/*.ts']);
    expect(resolveAllowedReadPath('src/x.ts', set, root)).toBe('src/x.ts');
    expect(() => resolveAllowedReadPath('src/sub/x.ts', set, root)).toThrow(UndeclaredFsReadError);
  });

  it('** crosses path separators', () => {
    const set = new Set(['src/**/*.ts']);
    expect(resolveAllowedReadPath('src/x.ts', set, root)).toBe('src/x.ts');
    expect(resolveAllowedReadPath('src/a/b/c.ts', set, root)).toBe('src/a/b/c.ts');
  });

  it('** rejects a file with a non-matching extension', () => {
    const set = new Set(['src/**/*.ts']);
    expect(() => resolveAllowedReadPath('src/a/b/c.js', set, root)).toThrow(UndeclaredFsReadError);
  });

  it('admits the literal-prefix directory of a glob entry (probe-able)', () => {
    // 'src/db' is the literal leading prefix of the glob; exists()/list() must be
    // able to probe it.
    const set = new Set(['src/db/*Repository.cs']);
    expect(resolveAllowedReadPath('src/db', set, root)).toBe('src/db');
  });

  it('admits a deeper literal-prefix directory of a glob entry', () => {
    const set = new Set(['src/db/repos/*Repository.cs']);
    expect(resolveAllowedReadPath('src/db', set, root)).toBe('src/db');
    expect(resolveAllowedReadPath('src/db/repos', set, root)).toBe('src/db/repos');
  });

  it('does NOT admit a sibling of the literal-prefix dir of a glob entry', () => {
    const set = new Set(['src/db/*Repository.cs']);
    expect(() => resolveAllowedReadPath('src/services', set, root)).toThrow(UndeclaredFsReadError);
  });
});

// ---------------------------------------------------------------------------
// PART B — createCtxFs gate (exists / read / list + touched tracking)
// ---------------------------------------------------------------------------
describe('createCtxFs — fs gate with real files', () => {
  let root: string;
  let touched: string[];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-bounty-fs-'));
    mkdirSync(path.join(root, 'src/db'), { recursive: true });
    mkdirSync(path.join(root, 'src/lib'), { recursive: true });
    writeFileSync(path.join(root, 'src/db/OrderRepository.cs'), 'order-repo');
    writeFileSync(path.join(root, 'src/db/UserRepository.cs'), 'user-repo');
    writeFileSync(path.join(root, 'src/db/Helper.cs'), 'helper');
    writeFileSync(path.join(root, 'src/lib/baz.ts'), 'baz');
    touched = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function mkFs(allowed: string[]) {
    return createCtxFs({ allowedSet: new Set(allowed), projectRoot: root, touchedFiles: touched });
  }

  it('read() returns content for a glob-admitted file', () => {
    const fs = mkFs(['src/db/*Repository.cs']);
    expect(fs.read('src/db/OrderRepository.cs')).toBe('order-repo');
    expect(fs.read('src/db/UserRepository.cs')).toBe('user-repo');
  });

  it('read() rejects a non-matching sibling of a glob entry', () => {
    const fs = mkFs(['src/db/*Repository.cs']);
    expect(() => fs.read('src/db/Helper.cs')).toThrow(UndeclaredFsReadError);
  });

  it('exists() returns "file" for a glob-admitted file', () => {
    const fs = mkFs(['src/db/*Repository.cs']);
    expect(fs.exists('src/db/OrderRepository.cs')).toBe('file');
  });

  it('exists() returns false (no throw) for a non-existent BUT glob-admitted name', () => {
    const fs = mkFs(['src/db/*Repository.cs']);
    // The name matches the glob (admitted by allow-set) but no such file exists.
    expect(fs.exists('src/db/GhostRepository.cs')).toBe(false);
  });

  it('exists() throws for a sibling NOT matching the glob', () => {
    const fs = mkFs(['src/db/*Repository.cs']);
    expect(() => fs.exists('src/db/Helper.cs')).toThrow(UndeclaredFsReadError);
  });

  it('exists() returns "dir" for the glob literal-prefix directory', () => {
    const fs = mkFs(['src/db/*Repository.cs']);
    expect(fs.exists('src/db')).toBe('dir');
  });

  it('list() enumerates the glob literal-prefix directory', () => {
    const fs = mkFs(['src/db/*Repository.cs']);
    const names = fs.list('src/db').map(e => e.name).sort();
    expect(names).toEqual(['Helper.cs', 'OrderRepository.cs', 'UserRepository.cs']);
  });

  it('list() reports kind for files and dirs', () => {
    const fs = mkFs(['src']);
    const entries = fs.list('src');
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: 'db', kind: 'dir' },
        { name: 'lib', kind: 'dir' },
      ]),
    );
  });

  it('every gate operation records the resolved path in touchedFiles (even on a glob match)', () => {
    const fs = mkFs(['src/db/*Repository.cs']);
    fs.read('src/db/OrderRepository.cs');
    expect(touched).toContain('src/db/OrderRepository.cs');
  });

  it('exists() records touched even when the file is missing (negative dependency)', () => {
    const fs = mkFs(['src/db/*Repository.cs']);
    fs.exists('src/db/GhostRepository.cs');
    expect(touched).toContain('src/db/GhostRepository.cs');
  });

  it('a rejected read does NOT record a touched path', () => {
    const fs = mkFs(['src/db/*Repository.cs']);
    expect(() => fs.read('src/db/Helper.cs')).toThrow();
    expect(touched).not.toContain('src/db/Helper.cs');
  });

  it('read() rejects absolute path through the gate', () => {
    const fs = mkFs(['src/lib']);
    expect(() => fs.read('/etc/passwd')).toThrow(UndeclaredFsReadError);
  });

  it('read() rejects .. traversal through an allowed dir prefix', () => {
    const fs = mkFs(['src/lib']);
    expect(() => fs.read('src/lib/../../../../../../etc/passwd')).toThrow(UndeclaredFsReadError);
  });

  it('read() throws when an allowed dir is a symlink pointing OUTSIDE the repo', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'yg-bounty-outside-'));
    writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
    symlinkSync(outside, path.join(root, 'src/lib/escape'), 'dir');
    try {
      const fs = mkFs(['src/lib']);
      expect(() => fs.read('src/lib/escape/secret.txt')).toThrow(UndeclaredFsReadError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('read() still works through a symlink pointing to an allowed file INSIDE the repo', () => {
    symlinkSync(path.join(root, 'src/lib/baz.ts'), path.join(root, 'src/lib/alias.ts'), 'file');
    const fs = mkFs(['src/lib']);
    expect(fs.read('src/lib/alias.ts')).toBe('baz');
  });
});

// ---------------------------------------------------------------------------
// PART C — ctx-graph toPublicNode: expandedFilesByNode vs raw-mapping fallback
// ---------------------------------------------------------------------------
describe('createCtxGraph.toPublicNode — expandedFilesByNode vs raw fallback', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-bounty-graph-'));
    mkdirSync(path.join(root, 'src/db'), { recursive: true });
    writeFileSync(path.join(root, 'src/a.ts'), 'a-content');
    writeFileSync(path.join(root, 'src/db/OrderRepository.cs'), 'order');
    writeFileSync(path.join(root, 'src/db/UserRepository.cs'), 'user');
    writeFileSync(path.join(root, 'src/db/Helper.cs'), 'helper');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    cleanupTestGraphs();
  });

  // --- raw-mapping fallback (no expandedFilesByNode supplied) --------------

  it('FALLBACK: a file-literal mapping resolves to its file with content', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/a.ts'] },
      ],
    });
    const touched: string[] = [];
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: touched });
    const b = ctxGraph.node('B')!;
    expect(b.files.map(f => f.path)).toEqual(['src/a.ts']);
    expect(b.files[0]?.content).toBe('a-content');
    expect(touched).toContain('src/a.ts');
  });

  it('FALLBACK: a GLOB mapping entry is NOT expanded — no files materialize', () => {
    // Without expandedFilesByNode, toPublicNode statSyncs the literal glob string
    // as a path. 'src/db/*Repository.cs' is not a real file, so it is skipped.
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/db/*Repository.cs'] },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: [] });
    const b = ctxGraph.node('B')!;
    expect(b.files).toEqual([]);
    // mapping field still carries the raw entry verbatim.
    expect(b.mapping).toEqual(['src/db/*Repository.cs']);
  });

  it('FALLBACK: a DIRECTORY mapping entry materializes no files (statSync is a dir, not a file)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/db'] },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: [] });
    const b = ctxGraph.node('B')!;
    expect(b.files).toEqual([]);
  });

  it('FALLBACK: a missing mapped file is skipped silently (no throw, no file)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/does-not-exist.ts'] },
      ],
    });
    const touched: string[] = [];
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: touched });
    const b = ctxGraph.node('B')!;
    expect(b.files).toEqual([]);
    // A skipped-missing path is NOT recorded as touched (only successful reads are).
    expect(touched).not.toContain('src/does-not-exist.ts');
  });

  // --- expandedFilesByNode supplied ---------------------------------------

  it('EXPANSION: a glob mapping resolves to the concrete matching files', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/db/*Repository.cs'] },
      ],
    });
    const expanded = new Map<string, string[]>([
      ['B', ['src/db/OrderRepository.cs', 'src/db/UserRepository.cs']],
    ]);
    const touched: string[] = [];
    const ctxGraph = createCtxGraph({
      currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: touched, expandedFilesByNode: expanded,
    });
    const b = ctxGraph.node('B')!;
    expect(b.files.map(f => f.path).sort()).toEqual(['src/db/OrderRepository.cs', 'src/db/UserRepository.cs']);
    expect(b.files.find(f => f.path === 'src/db/OrderRepository.cs')?.content).toBe('order');
    expect(b.files.find(f => f.path === 'src/db/UserRepository.cs')?.content).toBe('user');
    // The non-matching sibling was not in the expansion → not materialized.
    expect(b.files.find(f => f.path === 'src/db/Helper.cs')).toBeUndefined();
    expect(touched).toEqual(expect.arrayContaining(['src/db/OrderRepository.cs', 'src/db/UserRepository.cs']));
  });

  it('EXPANSION: a directory mapping resolves to its enumerated files', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/db'] },
      ],
    });
    const expanded = new Map<string, string[]>([
      ['B', ['src/db/OrderRepository.cs', 'src/db/UserRepository.cs', 'src/db/Helper.cs']],
    ]);
    const ctxGraph = createCtxGraph({
      currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: [], expandedFilesByNode: expanded,
    });
    const b = ctxGraph.node('B')!;
    expect(b.files.map(f => f.path).sort()).toEqual(
      ['src/db/Helper.cs', 'src/db/OrderRepository.cs', 'src/db/UserRepository.cs'],
    );
  });

  it('EXPANSION: the raw mapping field is preserved (glob string) while files are concrete', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/db/*Repository.cs'] },
      ],
    });
    const expanded = new Map<string, string[]>([['B', ['src/db/OrderRepository.cs']]]);
    const ctxGraph = createCtxGraph({
      currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: [], expandedFilesByNode: expanded,
    });
    const b = ctxGraph.node('B')!;
    expect(b.mapping).toEqual(['src/db/*Repository.cs']);
    expect(b.files.map(f => f.path)).toEqual(['src/db/OrderRepository.cs']);
  });

  it('EXPANSION: an empty expansion entry for a node yields no files (overrides raw mapping)', () => {
    // Map has the key with an empty array → preExpanded is [] (not undefined),
    // so the fallback is NOT used; zero files materialize even though raw mapping
    // points at a real file.
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/a.ts'] },
      ],
    });
    const expanded = new Map<string, string[]>([['B', []]]);
    const ctxGraph = createCtxGraph({
      currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: [], expandedFilesByNode: expanded,
    });
    const b = ctxGraph.node('B')!;
    expect(b.files).toEqual([]);
    // raw mapping unchanged.
    expect(b.mapping).toEqual(['src/a.ts']);
  });

  it('EXPANSION: a node ABSENT from the map falls back to raw mapping', () => {
    // The map is supplied but keyed only for a different node — current target
    // 'B' is absent, so preExpanded is undefined and the raw fallback runs.
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/a.ts'] },
      ],
    });
    const expanded = new Map<string, string[]>([['SOMEONE-ELSE', ['src/db/Helper.cs']]]);
    const ctxGraph = createCtxGraph({
      currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: [], expandedFilesByNode: expanded,
    });
    const b = ctxGraph.node('B')!;
    expect(b.files.map(f => f.path)).toEqual(['src/a.ts']);
    expect(b.files[0]?.content).toBe('a-content');
  });

  it('EXPANSION: a missing file in the expansion list is skipped silently', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/db/*Repository.cs'] },
      ],
    });
    const expanded = new Map<string, string[]>([
      ['B', ['src/db/OrderRepository.cs', 'src/db/GhostRepository.cs']],
    ]);
    const touched: string[] = [];
    const ctxGraph = createCtxGraph({
      currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: touched, expandedFilesByNode: expanded,
    });
    const b = ctxGraph.node('B')!;
    expect(b.files.map(f => f.path)).toEqual(['src/db/OrderRepository.cs']);
    expect(touched).toContain('src/db/OrderRepository.cs');
    expect(touched).not.toContain('src/db/GhostRepository.cs');
  });

  it('EXPANSION: applies through nodesByType (each node uses its expansion)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/db/*Repository.cs'] },
      ],
    });
    const expanded = new Map<string, string[]>([['B', ['src/db/OrderRepository.cs']]]);
    const ctxGraph = createCtxGraph({
      currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: [], expandedFilesByNode: expanded,
    });
    const providers = ctxGraph.nodesByType('provider');
    expect(providers).toHaveLength(1);
    expect(providers[0]?.files.map(f => f.path)).toEqual(['src/db/OrderRepository.cs']);
  });

  it('EXPANSION: applies through children() (descendant uses its expansion)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'root', type: 'module', mapping: ['src/a.ts'] },
        { path: 'root/child', type: 'provider', mapping: ['src/db/*Repository.cs'], parent: 'root' },
      ],
    });
    const expanded = new Map<string, string[]>([
      ['root/child', ['src/db/OrderRepository.cs', 'src/db/UserRepository.cs']],
    ]);
    const ctxGraph = createCtxGraph({
      currentNodePath: 'root', graph: g, projectRoot: root, touchedFiles: [], expandedFilesByNode: expanded,
    });
    const rootNode = ctxGraph.node('root')!;
    const kids = ctxGraph.children(rootNode);
    expect(kids).toHaveLength(1);
    expect(kids[0]?.files.map(f => f.path).sort()).toEqual(
      ['src/db/OrderRepository.cs', 'src/db/UserRepository.cs'],
    );
  });

  it('EXPANSION: the current node accessed via node(self) uses its own expansion', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'provider', mapping: ['src/db/*Repository.cs'] },
      ],
    });
    const expanded = new Map<string, string[]>([['A', ['src/db/OrderRepository.cs']]]);
    const ctxGraph = createCtxGraph({
      currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: [], expandedFilesByNode: expanded,
    });
    const self = ctxGraph.node('A')!;
    expect(self.files.map(f => f.path)).toEqual(['src/db/OrderRepository.cs']);
  });

  it('public node always reports id, type, mapping, and empty ports object', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/a.ts'] },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot: root, touchedFiles: [] });
    const b = ctxGraph.node('B')!;
    expect(b.id).toBe('B');
    expect(b.type).toBe('provider');
    expect(b.mapping).toEqual(['src/a.ts']);
    expect(b.ports).toEqual({});
  });
});
