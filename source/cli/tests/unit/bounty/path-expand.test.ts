/**
 * Bug-bounty exhaustive tests for expandMappingPaths (src/io/hash.ts).
 *
 * expandMappingPaths expands a node's mapping entries into the concrete list of
 * repo-relative POSIX file paths the entry covers. It handles:
 *   - an exact file entry → returned as-is (POSIX-normalized)
 *   - a directory entry → recursively expanded to its contained files
 *   - a glob entry (contains `*`) → minimatch-expanded from the glob's base dir
 *     (base = leading non-glob segments; projectRoot if the first segment globs)
 *   - `*` matches within ONE path segment; `**` crosses segments
 *   - a glob matching nothing → contributes nothing (empty)
 *   - .gitignore exclusion (root and nested) during directory/glob scans
 *   - a missing path → silently skipped
 *
 * Each test builds a fresh real temp tree via mkdtemp and removes it in finally.
 * No repo files, src/, or .yggdrasil/ are touched.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expandMappingPaths } from '../../../src/io/hash.js';

/** Create a fresh isolated temp dir; caller removes it in finally. */
async function freshTmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'yg-bounty-expand-'));
}

/** Write a file, creating parent dirs. Path is relative to root. */
async function put(root: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

describe('expandMappingPaths — exact file entries', () => {
  it('returns a single existing file path as-is', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'app.ts', 'const x = 1;');
      const result = await expandMappingPaths(root, ['app.ts']);
      expect(result).toEqual(['app.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a nested existing file path as-is (no expansion)', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/core/app.ts', 'x');
      const result = await expandMappingPaths(root, ['src/core/app.ts']);
      expect(result).toEqual(['src/core/app.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns multiple explicit files in entry order', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/b.ts', 'B');
      const result = await expandMappingPaths(root, ['src/a.ts', 'src/b.ts']);
      expect(result).toEqual(['src/a.ts', 'src/b.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('an explicitly mapped file is returned even if it sits under a directory that would gitignore it on a scan', async () => {
    // Direct file mapping is not subject to the directory-scan gitignore filter.
    const root = await freshTmp();
    try {
      await put(root, '.gitignore', 'secret.ts\n');
      await put(root, 'secret.ts', 'classified');
      const result = await expandMappingPaths(root, ['secret.ts']);
      expect(result).toEqual(['secret.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('expandMappingPaths — directory recursive expansion', () => {
  it('expands a flat directory to its files (POSIX relative paths)', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/a.cs', 'class A {}');
      await put(root, 'src/b.cs', 'class B {}');
      await put(root, 'src/c.cs', 'class C {}');
      const result = await expandMappingPaths(root, ['src']);
      expect(result.sort()).toEqual(['src/a.cs', 'src/b.cs', 'src/c.cs']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('expands nested directories recursively', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/sub/b.ts', 'B');
      await put(root, 'src/sub/deep/c.ts', 'C');
      const result = await expandMappingPaths(root, ['src']);
      expect(result.sort()).toEqual(['src/a.ts', 'src/sub/b.ts', 'src/sub/deep/c.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('expands the project-root directory entry "." ', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'a.ts', 'A');
      await put(root, 'sub/b.ts', 'B');
      const result = await expandMappingPaths(root, ['.']);
      // path.join('.', 'a.ts') === 'a.ts' — leading './' collapses.
      expect(result.sort()).toEqual(['a.ts', 'sub/b.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('an empty directory contributes nothing', async () => {
    const root = await freshTmp();
    try {
      await mkdir(path.join(root, 'empty'), { recursive: true });
      const result = await expandMappingPaths(root, ['empty']);
      expect(result).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a directory containing only subdirectories with files still expands deeply', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'pkg/a/x.ts', 'X');
      await put(root, 'pkg/b/y.ts', 'Y');
      const result = await expandMappingPaths(root, ['pkg']);
      expect(result.sort()).toEqual(['pkg/a/x.ts', 'pkg/b/y.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a directory entry with a trailing slash still expands (path.join handles it)', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/b.ts', 'B');
      const result = await expandMappingPaths(root, ['src/']);
      // toPosixPath strips trailing slash; results have no double slash.
      expect(result.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('expandMappingPaths — glob expansion (base-dir derivation)', () => {
  it('single-segment * matches files in ONE directory level only', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/db/FooRepository.cs', 'foo');
      await put(root, 'src/db/BarRepository.cs', 'bar');
      await put(root, 'src/db/Helper.cs', 'helper');
      await put(root, 'src/db/sub/NestedRepository.cs', 'nested');
      const result = await expandMappingPaths(root, ['src/db/*Repository.cs']);
      // Only direct children matching *Repository.cs; Helper.cs excluded; nested excluded.
      expect(result.sort()).toEqual([
        'src/db/BarRepository.cs',
        'src/db/FooRepository.cs',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('* does NOT cross a path separator', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/db/FooRepository.cs', 'foo');
      await put(root, 'src/db/nested/BarRepository.cs', 'bar');
      const result = await expandMappingPaths(root, ['src/db/*Repository.cs']);
      expect(result).toEqual(['src/db/FooRepository.cs']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('** crosses path separators (matches files at any depth)', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/index.ts', 'root');
      await put(root, 'src/a/b/c.ts', 'deep');
      await put(root, 'src/a/d.ts', 'mid');
      await put(root, 'src/notes.md', 'not ts');
      const result = await expandMappingPaths(root, ['src/**/*.ts']);
      expect(result.sort()).toEqual([
        'src/a/b/c.ts',
        'src/a/d.ts',
        'src/index.ts',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('base dir is derived from leading non-glob segments — files outside the base are never scanned', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'lib/b.ts', 'B'); // outside base "src"
      const result = await expandMappingPaths(root, ['src/**/*.ts']);
      expect(result).toEqual(['src/a.ts']);
      expect(result).not.toContain('lib/b.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('base dir is projectRoot when the FIRST segment is itself a glob', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'a.ts', 'A');
      await put(root, 'sub/b.ts', 'B');
      await put(root, 'sub/deep/c.ts', 'C');
      // **/*.ts globs from the very first segment → base is projectRoot.
      const result = await expandMappingPaths(root, ['**/*.ts']);
      expect(result.sort()).toEqual(['a.ts', 'sub/b.ts', 'sub/deep/c.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a leading single-* segment globs from projectRoot and is segment-bounded', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'top.ts', 'top');
      await put(root, 'nested/inner.ts', 'inner');
      // *.ts is a single-segment glob at root → only top-level *.ts.
      const result = await expandMappingPaths(root, ['*.ts']);
      expect(result).toEqual(['top.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a glob whose base directory has subdirectories returns only matching files (segment-precise)', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'pkg/a.spec.ts', 'spec a');
      await put(root, 'pkg/b.spec.ts', 'spec b');
      await put(root, 'pkg/c.ts', 'impl c');
      await put(root, 'pkg/sub/d.spec.ts', 'nested spec'); // not matched by single *
      const result = await expandMappingPaths(root, ['pkg/*.spec.ts']);
      expect(result.sort()).toEqual(['pkg/a.spec.ts', 'pkg/b.spec.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deep ** with a trailing single-segment * combines correctly', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/a/FooRepository.cs', 'foo');
      await put(root, 'src/b/c/BarRepository.cs', 'bar');
      await put(root, 'src/b/c/Helper.cs', 'helper');
      const result = await expandMappingPaths(root, ['src/**/*Repository.cs']);
      expect(result.sort()).toEqual([
        'src/a/FooRepository.cs',
        'src/b/c/BarRepository.cs',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('matches dotfiles inside a glob scan ({ dot: true })', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/visible.ts', 'visible');
      await put(root, 'src/.hidden/secret.ts', 'hidden ts');
      const result = await expandMappingPaths(root, ['src/**/*.ts']);
      expect(result.sort()).toEqual(['src/.hidden/secret.ts', 'src/visible.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('expandMappingPaths — glob matching nothing → empty', () => {
  it('a glob matching no file in an existing base dir contributes nothing', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/b.ts', 'B');
      const result = await expandMappingPaths(root, ['src/*.cs']);
      expect(result).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a glob whose base directory is missing yields nothing (silent skip)', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/a.ts', 'A');
      const result = await expandMappingPaths(root, ['nope/**/*.ts']);
      expect(result).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('an extension glob that matches nothing returns empty without throwing', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'src/a.ts', 'A');
      const result = await expandMappingPaths(root, ['src/**/*.py']);
      expect(result).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('expandMappingPaths — .gitignore exclusion', () => {
  it('root .gitignore excludes a directory subtree during directory scan', async () => {
    const root = await freshTmp();
    try {
      await put(root, '.gitignore', 'dist/\n');
      await put(root, 'src/app.ts', 'app');
      await put(root, 'src/dist/bundle.js', 'bundle');
      const result = await expandMappingPaths(root, ['src']);
      expect(result).toEqual(['src/app.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('root .gitignore excludes a named file during directory scan', async () => {
    const root = await freshTmp();
    try {
      await put(root, '.gitignore', 'secret.ts\n');
      await put(root, 'src/app.ts', 'app');
      await put(root, 'src/secret.ts', 'shh'); // gitignore "secret.ts" matches any depth
      const result = await expandMappingPaths(root, ['src']);
      expect(result).toEqual(['src/app.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('nested .gitignore in a subdirectory excludes its own patterns', async () => {
    const root = await freshTmp();
    try {
      await put(root, '.gitignore', 'node_modules/\n');
      await put(root, 'project/.gitignore', '*.db\n*.log\n');
      await put(root, 'project/app.ts', 'code');
      await put(root, 'project/data.db', 'sqlite');
      await put(root, 'project/sub/test.db', 'more');
      await put(root, 'project/sub/debug.log', 'log');
      await put(root, 'project/sub/index.ts', 'export {}');
      const result = await expandMappingPaths(root, ['project']);
      // The nested .gitignore file is a regular file and is not self-ignored,
      // so it is part of the scan; only the *.db / *.log files are excluded.
      expect(result.sort()).toEqual([
        'project/.gitignore',
        'project/app.ts',
        'project/sub/index.ts',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('root .gitignore is honored during a glob scan too', async () => {
    const root = await freshTmp();
    try {
      await put(root, '.gitignore', 'generated/\n');
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/generated/auto.ts', 'auto');
      const result = await expandMappingPaths(root, ['src/**/*.ts']);
      expect(result).toEqual(['src/a.ts']);
      expect(result).not.toContain('src/generated/auto.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a file ignored by .gitignore is still returned when mapped EXACTLY (direct file mapping bypasses scan filter)', async () => {
    const root = await freshTmp();
    try {
      await put(root, '.gitignore', 'build.ts\n');
      await put(root, 'build.ts', 'generated');
      // Exact file mapping is not a directory scan → gitignore does not filter it.
      const result = await expandMappingPaths(root, ['build.ts']);
      expect(result).toEqual(['build.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('expandMappingPaths — missing path handling', () => {
  it('skips a missing file entry silently', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'exists.ts', 'ok');
      const result = await expandMappingPaths(root, ['exists.ts', 'ghost.ts']);
      expect(result).toEqual(['exists.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips a missing directory entry silently', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'exists.ts', 'ok');
      const result = await expandMappingPaths(root, ['exists.ts', 'nonexistent/']);
      expect(result).toEqual(['exists.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns empty for an all-missing mapping list', async () => {
    const root = await freshTmp();
    try {
      const result = await expandMappingPaths(root, ['gone.ts', 'missing/']);
      expect(result).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns empty for an empty mapping list', async () => {
    const root = await freshTmp();
    try {
      const result = await expandMappingPaths(root, []);
      expect(result).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('expandMappingPaths — mixed entries and combinations', () => {
  it('handles a mix of an exact file and a directory', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'root.ts', 'root');
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/b.ts', 'B');
      const result = await expandMappingPaths(root, ['root.ts', 'src']);
      expect(result.sort()).toEqual(['root.ts', 'src/a.ts', 'src/b.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles a mix of an exact file, a directory, and a glob', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'README.ts', 'readme');
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/b.ts', 'B');
      await put(root, 'tests/x.spec.ts', 'spec x');
      await put(root, 'tests/y.spec.ts', 'spec y');
      await put(root, 'tests/helper.ts', 'helper'); // not *.spec.ts
      const result = await expandMappingPaths(root, [
        'README.ts',
        'src',
        'tests/*.spec.ts',
      ]);
      expect(result.sort()).toEqual([
        'README.ts',
        'src/a.ts',
        'src/b.ts',
        'tests/x.spec.ts',
        'tests/y.spec.ts',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a file matched by both a directory entry and a glob entry appears once per producing entry (no dedup contract)', async () => {
    // expandMappingPaths does not promise de-duplication across entries; document
    // the actual behavior: the same file can appear once from the dir scan and
    // once from the glob.
    const root = await freshTmp();
    try {
      await put(root, 'src/a.ts', 'A');
      const result = await expandMappingPaths(root, ['src', 'src/*.ts']);
      expect(result).toContain('src/a.ts');
      // Both entries match a.ts → two occurrences.
      expect(result.filter((p) => p === 'src/a.ts')).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves overall entry order (directory results follow their producing entry order)', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'z.ts', 'Z');
      await put(root, 'a/inner.ts', 'inner');
      const result = await expandMappingPaths(root, ['z.ts', 'a']);
      // z.ts (exact) comes before a/inner.ts (dir expansion of the 2nd entry).
      expect(result).toEqual(['z.ts', 'a/inner.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('expandMappingPaths — bracket / brace names are literal (only * is a glob)', () => {
  it('a bracket directory name maps literally as a directory (Next.js style route)', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'app/[id]/page.tsx', 'page');
      await put(root, 'app/[id]/layout.tsx', 'layout');
      // No '*', so this is a plain directory entry, not a glob char-class.
      const result = await expandMappingPaths(root, ['app/[id]']);
      expect(result.sort()).toEqual(['app/[id]/layout.tsx', 'app/[id]/page.tsx']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('an exact bracket file path maps literally', async () => {
    const root = await freshTmp();
    try {
      await put(root, 'app/[slug]/page.tsx', 'page');
      const result = await expandMappingPaths(root, ['app/[slug]/page.tsx']);
      expect(result).toEqual(['app/[slug]/page.tsx']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('expandMappingPaths — directory scan skips non-regular files', () => {
  it('skips a symlink entry inside a scanned directory (only regular files are returned)', async () => {
    if (process.platform === 'win32') return;
    const root = await freshTmp();
    try {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/sub/b.ts', 'B');
      await symlink(path.join(root, 'src/sub/b.ts'), path.join(root, 'src/link.ts'));
      const result = await expandMappingPaths(root, ['src']);
      // The symlink is neither isFile() nor isDirectory() under withFileTypes,
      // so it is skipped; the real files remain.
      expect(result.sort()).toEqual(['src/a.ts', 'src/sub/b.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
