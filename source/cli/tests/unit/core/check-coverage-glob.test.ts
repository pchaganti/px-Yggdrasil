/**
 * Tests for glob-pattern mapping entries in coverage/ownership checks.
 * Verifies that glob entries scope precisely (matching files are covered,
 * non-matching files in the same directory are not), while plain entries
 * continue to behave exactly as before.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { scanUncoveredFiles } from '../../../src/core/check.js';
import { expandMappingPaths, hashTrackedFiles } from '../../../src/io/hash.js';
import { checkMappingPathsExist } from '../../../src/core/checks/mapping.js';
import type { TrackedFile } from '../../../src/core/graph/files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function createGlobProject(name: string, opts: {
  mappingYaml: string;
  files: Record<string, string>;
}) {
  const tmpDir = path.join(__dirname, '../../fixtures', `tmp-glob-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc', 'repo');
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });

  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.0.0"\n');
  await writeFile(
    path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
    'name: Svc\ntype: service\ndescription: parent\n',
  );
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    `name: Repo\ntype: service\ndescription: repo layer\n${opts.mappingYaml}`,
  );

  for (const [relPath, content] of Object.entries(opts.files)) {
    const abs = path.join(tmpDir, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  return { tmpDir, yggRoot };
}

// ── glob mapping: precise ownership ──────────────────────────────────────────

describe('scanUncoveredFiles — glob mapping', () => {
  it('a *Repository.cs glob covers only matching files, not non-matching ones', async () => {
    const { tmpDir } = await createGlobProject('scan-repo', {
      mappingYaml: 'mapping:\n  - src/repo/*Repository.cs\n',
      files: {
        'src/repo/FooRepository.cs': 'class Foo {}',
        'src/repo/BarRepository.cs': 'class Bar {}',
        'src/repo/Helper.cs': 'class Helper {}',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const uncovered = scanUncoveredFiles(graph, [
        'src/repo/FooRepository.cs',
        'src/repo/BarRepository.cs',
        'src/repo/Helper.cs',
      ]);
      // Matching files should be covered
      expect(uncovered).not.toContain('src/repo/FooRepository.cs');
      expect(uncovered).not.toContain('src/repo/BarRepository.cs');
      // Non-matching file should be uncovered
      expect(uncovered).toContain('src/repo/Helper.cs');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('a src/**/*.ts glob covers files at any depth under src', async () => {
    const { tmpDir } = await createGlobProject('scan-deep', {
      mappingYaml: 'mapping:\n  - src/**/*.ts\n',
      files: {
        'src/index.ts': 'export {}',
        'src/a/b/c.ts': 'export {}',
        'src/util.js': 'module.exports = {}', // .js — should NOT be covered
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const uncovered = scanUncoveredFiles(graph, [
        'src/index.ts',
        'src/a/b/c.ts',
        'src/util.js',
      ]);
      expect(uncovered).not.toContain('src/index.ts');
      expect(uncovered).not.toContain('src/a/b/c.ts');
      expect(uncovered).toContain('src/util.js');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('plain directory mapping still covers all files inside (backward compat)', async () => {
    const { tmpDir } = await createGlobProject('scan-plain', {
      mappingYaml: 'mapping:\n  - src/repo\n',
      files: {
        'src/repo/FooRepository.cs': 'class Foo {}',
        'src/repo/Helper.cs': 'class Helper {}',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const uncovered = scanUncoveredFiles(graph, [
        'src/repo/FooRepository.cs',
        'src/repo/Helper.cs',
      ]);
      expect(uncovered).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── expandMappingPaths — glob entries ─────────────────────────────────────────

describe('expandMappingPaths — glob entries', () => {
  it('expands a *Repository.cs glob to only matching files', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-glob-expand');
    const srcDir = path.join(tmpDir, 'src', 'repo');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(srcDir, { recursive: true });
    try {
      await writeFile(path.join(srcDir, 'FooRepository.cs'), 'class Foo {}');
      await writeFile(path.join(srcDir, 'BarRepository.cs'), 'class Bar {}');
      await writeFile(path.join(srcDir, 'Helper.cs'), 'class Helper {}');

      const result = await expandMappingPaths(tmpDir, ['src/repo/*Repository.cs']);
      expect(result.sort()).toEqual([
        'src/repo/BarRepository.cs',
        'src/repo/FooRepository.cs',
      ]);
      expect(result).not.toContain('src/repo/Helper.cs');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('expands a **/*.ts glob to all .ts files at any depth', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-glob-expand-deep');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(path.join(tmpDir, 'src', 'a', 'b'), { recursive: true });
    try {
      await writeFile(path.join(tmpDir, 'src', 'index.ts'), 'export {}');
      await writeFile(path.join(tmpDir, 'src', 'a', 'b', 'c.ts'), 'export {}');
      await writeFile(path.join(tmpDir, 'src', 'util.js'), 'module.exports = {}');

      const result = await expandMappingPaths(tmpDir, ['src/**/*.ts']);
      expect(result.sort()).toEqual(['src/a/b/c.ts', 'src/index.ts']);
      expect(result).not.toContain('src/util.js');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty array when glob matches no files (no error)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-glob-expand-nomatch');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(path.join(tmpDir, 'src'), { recursive: true });
    try {
      await writeFile(path.join(tmpDir, 'src', 'Helper.cs'), 'class Helper {}');

      const result = await expandMappingPaths(tmpDir, ['src/*Repository.cs']);
      expect(result).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('plain directory mapping is unchanged (backward compat)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-glob-expand-plain');
    const srcDir = path.join(tmpDir, 'src');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(srcDir, { recursive: true });
    try {
      await writeFile(path.join(srcDir, 'a.cs'), 'class A {}');
      await writeFile(path.join(srcDir, 'b.cs'), 'class B {}');

      const result = await expandMappingPaths(tmpDir, ['src']);
      expect(result.sort()).toEqual(['src/a.cs', 'src/b.cs']);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── checkMappingPathsExist — glob entries ─────────────────────────────────────

describe('checkMappingPathsExist — glob entries', () => {
  it('passes when glob matches at least one file', async () => {
    const { tmpDir } = await createGlobProject('exist-pass', {
      mappingYaml: 'mapping:\n  - src/repo/*Repository.cs\n',
      files: {
        'src/repo/FooRepository.cs': 'class Foo {}',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const issues = await checkMappingPathsExist(graph);
      expect(issues.filter((i) => i.code === 'mapping-path-missing')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('errors when glob matches zero files', async () => {
    const { tmpDir } = await createGlobProject('exist-fail', {
      mappingYaml: 'mapping:\n  - src/repo/*Repository.cs\n',
      files: {
        'src/repo/Helper.cs': 'class Helper {}', // exists but does not match the glob
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const issues = await checkMappingPathsExist(graph);
      const missing = issues.filter((i) => i.code === 'mapping-path-missing');
      expect(missing).toHaveLength(1);
      expect(missing[0].nodePath).toBe('svc/repo');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('plain path that exists does not produce an error (backward compat)', async () => {
    const { tmpDir } = await createGlobProject('exist-plain', {
      mappingYaml: 'mapping:\n  - src/repo/FooRepository.cs\n',
      files: {
        'src/repo/FooRepository.cs': 'class Foo {}',
      },
    });
    try {
      const graph = await loadGraph(tmpDir);
      const issues = await checkMappingPathsExist(graph);
      expect(issues.filter((i) => i.code === 'mapping-path-missing')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── hashTrackedFiles — glob entries participate in the drift baseline ─────────
// Regression: a glob mapping entry must expand to its concrete files in the
// drift hash. Otherwise the baseline (and the reviewer's source list, which is
// Object.keys(fileHashes)) silently omits glob-mapped files: edits would not
// drift and the reviewer would never re-verify them.

describe('hashTrackedFiles — glob mapping entries', () => {
  const src = (name: string): TrackedFile => ({ path: name, category: 'source', layer: 'source' });

  it('expands a glob entry into its matching files in the drift hash', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'ygg-hash-glob-'));
    const repo = path.join(tmpDir, 'src', 'repo');
    await mkdir(repo, { recursive: true });
    try {
      await writeFile(path.join(repo, 'FooRepository.cs'), 'class Foo {}');
      await writeFile(path.join(repo, 'BarRepository.cs'), 'class Bar {}');
      await writeFile(path.join(repo, 'Helper.cs'), 'class Helper {}');

      const { fileHashes } = await hashTrackedFiles(tmpDir, [src('src/repo/*Repository.cs')]);
      const tracked = Object.keys(fileHashes).sort();
      expect(tracked).toEqual(['src/repo/BarRepository.cs', 'src/repo/FooRepository.cs']);
      expect(tracked).not.toContain('src/repo/Helper.cs');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('editing a glob-mapped file changes the canonical hash (drift is detected)', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'ygg-hash-glob-drift-'));
    const repo = path.join(tmpDir, 'src', 'repo');
    await mkdir(repo, { recursive: true });
    try {
      const foo = path.join(repo, 'FooRepository.cs');
      await writeFile(foo, 'class Foo {}');
      const before = await hashTrackedFiles(tmpDir, [src('src/repo/*Repository.cs')]);

      await writeFile(foo, 'class Foo { void Added() {} }');
      const after = await hashTrackedFiles(tmpDir, [src('src/repo/*Repository.cs')], undefined, undefined, undefined, undefined, false);

      expect(after.canonicalHash).not.toBe(before.canonicalHash);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('child-wins: a glob excludePrefix removes the descendant-owned files from the parent set', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'ygg-hash-glob-childwins-'));
    const repo = path.join(tmpDir, 'src', 'repo');
    await mkdir(repo, { recursive: true });
    try {
      await writeFile(path.join(repo, 'FooRepository.cs'), 'class Foo {}');
      await writeFile(path.join(repo, 'Helper.cs'), 'class Helper {}');

      // Parent maps the whole dir; a child node owns *Repository.cs via a glob.
      const { fileHashes } = await hashTrackedFiles(
        tmpDir,
        [src('src/repo')],
        undefined,
        ['src/repo/*Repository.cs'], // excludePrefixes (child-wins)
      );
      const tracked = Object.keys(fileHashes);
      expect(tracked).toContain('src/repo/Helper.cs');
      expect(tracked).not.toContain('src/repo/FooRepository.cs');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
