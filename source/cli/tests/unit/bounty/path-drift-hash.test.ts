import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  hashTrackedFiles,
  hashString,
  computeCanonicalHash,
} from '../../../src/io/hash.js';
import type { TrackedFile } from '../../../src/core/graph/files.js';
import type { DriftIdentity } from '../../../src/model/drift.js';

// Mirror hash.ts's EMPTY_IDENTITY: ownSubset = empty-string digest, no ports/aspects.
const EMPTY_IDENTITY: DriftIdentity = { ownSubset: hashString(''), ports: {}, aspects: {} };

/**
 * Run `body` against a fresh, isolated tmp tree and always clean it up. NEVER
 * touches the repo's own files — mkdtemp under os.tmpdir() only.
 */
async function withTmp(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-bounty-path-drift-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Write a file, creating parent directories as needed. */
async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

const src = (p: string): TrackedFile => ({ path: p, category: 'source', layer: 'source' });

describe('hashTrackedFiles — glob mapping entry expansion', () => {
  it('expands a single-segment * glob into per-file hashes for matching files only', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/db/FooRepository.cs', 'class Foo {}');
      await put(root, 'src/db/BarRepository.cs', 'class Bar {}');
      await put(root, 'src/db/Helper.cs', 'class Helper {}');

      const { fileHashes } = await hashTrackedFiles(root, [src('src/db/*Repository.cs')]);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toEqual(['src/db/BarRepository.cs', 'src/db/FooRepository.cs']);
      // Non-matching file is not in the set.
      expect(keys).not.toContain('src/db/Helper.cs');
      // Per-file hash equals the content hash.
      expect(fileHashes['src/db/FooRepository.cs']).toBe(hashString('class Foo {}'));
      expect(fileHashes['src/db/BarRepository.cs']).toBe(hashString('class Bar {}'));
    });
  });

  it('* does not cross path separators — a match in a subdirectory is excluded', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/db/FooRepository.cs', 'top');
      await put(root, 'src/db/sub/NestedRepository.cs', 'nested');

      const { fileHashes } = await hashTrackedFiles(root, [src('src/db/*Repository.cs')]);
      const keys = Object.keys(fileHashes);

      expect(keys).toContain('src/db/FooRepository.cs');
      expect(keys).not.toContain('src/db/sub/NestedRepository.cs');
    });
  });

  it('** crosses path separators — matches files at any depth under the base', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/sub/b.ts', 'B');
      await put(root, 'src/sub/deep/c.ts', 'C');
      await put(root, 'src/note.md', 'not ts');

      const { fileHashes } = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toEqual(['src/a.ts', 'src/sub/b.ts', 'src/sub/deep/c.ts']);
      expect(keys).not.toContain('src/note.md');
    });
  });

  it('** does not match files in a sibling root outside the glob base', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/index.ts', 'in src');
      await put(root, 'lib/index.ts', 'in lib');

      const { fileHashes } = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      const keys = Object.keys(fileHashes);

      expect(keys).toContain('src/index.ts');
      expect(keys).not.toContain('lib/index.ts');
    });
  });

  it('a root-level glob (first segment is the wildcard) expands from the project root', async () => {
    await withTmp(async (root) => {
      await put(root, 'a.ts', 'A');
      await put(root, 'b.ts', 'B');
      await put(root, 'c.md', 'C');
      await put(root, 'nested/d.ts', 'D'); // single-segment * must NOT recurse

      const { fileHashes } = await hashTrackedFiles(root, [src('*.ts')]);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toEqual(['a.ts', 'b.ts']);
      expect(keys).not.toContain('c.md');
      expect(keys).not.toContain('nested/d.ts');
    });
  });

  it('a deep root-level ** glob recurses from the project root', async () => {
    await withTmp(async (root) => {
      await put(root, 'a.ts', 'A');
      await put(root, 'nested/d.ts', 'D');
      await put(root, 'nested/deep/e.ts', 'E');
      await put(root, 'x.md', 'X');

      const { fileHashes } = await hashTrackedFiles(root, [src('**/*.ts')]);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toEqual(['a.ts', 'nested/d.ts', 'nested/deep/e.ts']);
      expect(keys).not.toContain('x.md');
    });
  });

  it('returns POSIX-normalized relative paths as fileHash keys', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/feature/handler.ts', 'h');

      const { fileHashes } = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      for (const key of Object.keys(fileHashes)) {
        expect(key).not.toContain('\\');
      }
      expect(Object.keys(fileHashes)).toContain('src/feature/handler.ts');
    });
  });

  it('a glob matching dotfiles includes them (dot: true)', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/.hidden/config.ts', 'hidden');
      await put(root, 'src/visible.ts', 'vis');

      const { fileHashes } = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toContain('src/.hidden/config.ts');
      expect(keys).toContain('src/visible.ts');
    });
  });

  it('a glob whose base directory is missing yields an empty set (silent skip)', async () => {
    await withTmp(async (root) => {
      // No 'src' directory at all.
      const { fileHashes, canonicalHash } = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      expect(fileHashes).toEqual({});
      // Empty files + empty identity fold deterministically.
      expect(canonicalHash).toBe(computeCanonicalHash({}, EMPTY_IDENTITY));
    });
  });

  it('a glob matching zero files (base exists, no match) yields an empty set', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/readme.md', 'docs only');

      const { fileHashes } = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      expect(fileHashes).toEqual({});
    });
  });

  it('records mtimes for every glob-expanded file', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/b.ts', 'B');

      const { fileMtimes } = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      expect(Object.keys(fileMtimes).sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(typeof fileMtimes['src/a.ts']).toBe('number');
    });
  });
});

describe('hashTrackedFiles — editing a glob-matched file changes the canonical hash', () => {
  it('editing one glob-matched file changes both its per-file hash and the canonical hash', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'original A');
      await put(root, 'src/b.ts', 'B');

      const before = await hashTrackedFiles(root, [src('src/**/*.ts')]);

      await put(root, 'src/a.ts', 'edited A');
      const after = await hashTrackedFiles(root, [src('src/**/*.ts')]);

      // The edited file's per-file hash changed.
      expect(after.fileHashes['src/a.ts']).not.toBe(before.fileHashes['src/a.ts']);
      // The untouched file's hash is stable.
      expect(after.fileHashes['src/b.ts']).toBe(before.fileHashes['src/b.ts']);
      // The canonical (baseline-comparable) hash changed → drift detected.
      expect(after.canonicalHash).not.toBe(before.canonicalHash);
    });
  });

  it('a new file appearing under the glob changes the canonical hash (membership drift)', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      const before = await hashTrackedFiles(root, [src('src/**/*.ts')]);

      await put(root, 'src/c.ts', 'C');
      const after = await hashTrackedFiles(root, [src('src/**/*.ts')]);

      expect(Object.keys(after.fileHashes).sort()).toEqual(['src/a.ts', 'src/c.ts']);
      expect(after.canonicalHash).not.toBe(before.canonicalHash);
    });
  });

  it('removing a glob-matched file changes the canonical hash', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/b.ts', 'B');
      const before = await hashTrackedFiles(root, [src('src/**/*.ts')]);

      await rm(path.join(root, 'src/b.ts'));
      const after = await hashTrackedFiles(root, [src('src/**/*.ts')]);

      expect(Object.keys(after.fileHashes)).toEqual(['src/a.ts']);
      expect(after.canonicalHash).not.toBe(before.canonicalHash);
    });
  });

  it('no change yields a stable canonical hash across runs', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/sub/b.ts', 'B');

      const r1 = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      const r2 = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      expect(r2.canonicalHash).toBe(r1.canonicalHash);
      expect(r2.fileHashes).toEqual(r1.fileHashes);
    });
  });

  it('a content change that preserves mtime is detected when reuseByMtime is false', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'v1');
      const first = await hashTrackedFiles(root, [src('src/**/*.ts')]);

      // Rewrite content but force the OLD mtime back (simulates touch -r).
      await put(root, 'src/a.ts', 'v2-different-length');
      const { utimes } = await import('node:fs/promises');
      const oldMtimeSec = first.fileMtimes['src/a.ts'] / 1000;
      await utimes(path.join(root, 'src/a.ts'), oldMtimeSec, oldMtimeSec);

      const stored = { hashes: first.fileHashes, mtimes: first.fileMtimes };

      // reuseByMtime=true would reuse the stale hash (mtime matches) → miss the change.
      // reuseByMtime=false must always re-read and detect the change.
      const strict = await hashTrackedFiles(
        root,
        [src('src/**/*.ts')],
        stored,
        undefined,
        undefined,
        undefined,
        false,
      );
      expect(strict.fileHashes['src/a.ts']).toBe(hashString('v2-different-length'));
      expect(strict.fileHashes['src/a.ts']).not.toBe(first.fileHashes['src/a.ts']);
      expect(strict.canonicalHash).not.toBe(first.canonicalHash);
    });
  });

  it('reuses the stored hash for a glob-expanded file when its mtime is unchanged (cache hit)', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      const first = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      const stored = { hashes: first.fileHashes, mtimes: first.fileMtimes };

      const second = await hashTrackedFiles(root, [src('src/**/*.ts')], stored);
      expect(second.fileHashes).toEqual(first.fileHashes);
      expect(second.canonicalHash).toBe(first.canonicalHash);
    });
  });
});

describe('hashTrackedFiles — child-wins via glob excludePrefix', () => {
  it('a glob excludePrefix removes descendant-owned files from the parent set', async () => {
    await withTmp(async (root) => {
      // Parent maps the whole src tree; a child node owns src/db/*Repository.cs.
      await put(root, 'src/app.ts', 'app');
      await put(root, 'src/db/FooRepository.cs', 'foo');
      await put(root, 'src/db/BarRepository.cs', 'bar');
      await put(root, 'src/db/Helper.cs', 'helper');

      const parentTracked: TrackedFile[] = [src('src')];
      const childGlob = 'src/db/*Repository.cs';

      const { fileHashes } = await hashTrackedFiles(root, parentTracked, undefined, [childGlob]);
      const keys = Object.keys(fileHashes).sort();

      // Child-owned repository files removed from the parent set.
      expect(keys).not.toContain('src/db/FooRepository.cs');
      expect(keys).not.toContain('src/db/BarRepository.cs');
      // Non-matching sibling stays with the parent.
      expect(keys).toContain('src/db/Helper.cs');
      expect(keys).toContain('src/app.ts');
    });
  });

  it('the parent canonical hash is insensitive to edits in child-owned (excluded) files', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/app.ts', 'app');
      await put(root, 'src/db/FooRepository.cs', 'foo v1');

      const parentTracked: TrackedFile[] = [src('src')];
      const childGlob = 'src/db/*Repository.cs';

      const before = await hashTrackedFiles(root, parentTracked, undefined, [childGlob]);

      // Edit the child-owned file — the parent must NOT drift.
      await put(root, 'src/db/FooRepository.cs', 'foo v2 totally different');
      const after = await hashTrackedFiles(root, parentTracked, undefined, [childGlob]);

      expect(after.canonicalHash).toBe(before.canonicalHash);
      expect(Object.keys(after.fileHashes)).not.toContain('src/db/FooRepository.cs');
    });
  });

  it('a glob excludePrefix that crosses segments (**) removes all matching descendants', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/keep.ts', 'keep');
      await put(root, 'src/gen/a.ts', 'gen-a');
      await put(root, 'src/gen/deep/b.ts', 'gen-b');

      const { fileHashes } = await hashTrackedFiles(root, [src('src')], undefined, ['src/gen/**/*.ts']);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toContain('src/keep.ts');
      expect(keys).not.toContain('src/gen/a.ts');
      expect(keys).not.toContain('src/gen/deep/b.ts');
    });
  });

  it('a glob excludePrefix only removes files it actually matches', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/db/FooRepository.cs', 'foo');
      await put(root, 'src/db/FooService.cs', 'svc');

      const { fileHashes } = await hashTrackedFiles(root, [src('src')], undefined, ['src/db/*Repository.cs']);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).not.toContain('src/db/FooRepository.cs');
      expect(keys).toContain('src/db/FooService.cs');
    });
  });

  it('child-wins also applies when the PARENT entry is itself a glob', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/b.ts', 'B');
      await put(root, 'src/c.ts', 'C');

      // Parent owns all *.ts; child owns the single exact file src/b.ts.
      const { fileHashes } = await hashTrackedFiles(root, [src('src/*.ts')], undefined, ['src/b.ts']);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toEqual(['src/a.ts', 'src/c.ts']);
      expect(keys).not.toContain('src/b.ts');
    });
  });

  it('an empty excludePrefixes array excludes nothing (parent keeps everything)', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/db/FooRepository.cs', 'foo');

      const { fileHashes } = await hashTrackedFiles(root, [src('src')], undefined, []);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toEqual(['src/a.ts', 'src/db/FooRepository.cs']);
    });
  });

  it('omitting excludePrefixes (undefined) excludes nothing', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/db/FooRepository.cs', 'foo');

      const { fileHashes } = await hashTrackedFiles(root, [src('src')]);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toEqual(['src/a.ts', 'src/db/FooRepository.cs']);
    });
  });
});

describe('hashTrackedFiles — child-wins via plain (literal) excludePrefix', () => {
  it('a plain directory excludePrefix removes the whole subtree', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/app.ts', 'app');
      await put(root, 'src/feature/handler.ts', 'h');
      await put(root, 'src/feature/util.ts', 'u');

      const { fileHashes } = await hashTrackedFiles(root, [src('src')], undefined, ['src/feature']);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toEqual(['src/app.ts']);
      expect(keys.some((p) => p.startsWith('src/feature/'))).toBe(false);
    });
  });

  it('a plain exact-file excludePrefix removes only that file', async () => {
    await withTmp(async (root) => {
      await put(root, 'keep.ts', 'keep');
      await put(root, 'drop.ts', 'drop');

      const { fileHashes } = await hashTrackedFiles(
        root,
        [src('keep.ts'), src('drop.ts')],
        undefined,
        ['drop.ts'],
      );
      const keys = Object.keys(fileHashes);

      expect(keys).toContain('keep.ts');
      expect(keys).not.toContain('drop.ts');
    });
  });

  it('a directory excludePrefix must not remove a sibling sharing the name as a prefix string', async () => {
    await withTmp(async (root) => {
      // 'src/feature' must not exclude 'src/feature-extra/...' (boundary correctness).
      await put(root, 'src/feature/in.ts', 'in');
      await put(root, 'src/feature-extra/out.ts', 'out');

      const { fileHashes } = await hashTrackedFiles(root, [src('src')], undefined, ['src/feature']);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).not.toContain('src/feature/in.ts');
      expect(keys).toContain('src/feature-extra/out.ts');
    });
  });
});

describe('hashTrackedFiles — plain dir + exact entries unchanged (regression)', () => {
  it('a plain directory entry expands to all contained files (recursively)', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/sub/b.ts', 'B');
      await put(root, 'src/sub/deep/c.ts', 'C');

      const { fileHashes } = await hashTrackedFiles(root, [src('src')]);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toEqual(['src/a.ts', 'src/sub/b.ts', 'src/sub/deep/c.ts']);
      expect(fileHashes['src/a.ts']).toBe(hashString('A'));
    });
  });

  it('an exact-file entry hashes exactly that file', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/only.ts', 'only content');

      const { fileHashes } = await hashTrackedFiles(root, [src('src/only.ts')]);
      expect(fileHashes).toEqual({ 'src/only.ts': hashString('only content') });
    });
  });

  it('mixed plain dir + exact-file entries co-exist without double counting', async () => {
    await withTmp(async (root) => {
      await put(root, 'root.ts', 'root');
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/b.ts', 'B');

      const { fileHashes } = await hashTrackedFiles(root, [src('root.ts'), src('src')]);
      const keys = Object.keys(fileHashes).sort();

      expect(keys).toEqual(['root.ts', 'src/a.ts', 'src/b.ts']);
    });
  });

  it('editing a file under a plain directory entry changes the canonical hash', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A v1');
      await put(root, 'src/b.ts', 'B');
      const before = await hashTrackedFiles(root, [src('src')]);

      await put(root, 'src/a.ts', 'A v2');
      const after = await hashTrackedFiles(root, [src('src')]);

      expect(after.fileHashes['src/a.ts']).not.toBe(before.fileHashes['src/a.ts']);
      expect(after.canonicalHash).not.toBe(before.canonicalHash);
    });
  });

  it('a missing exact-file entry is skipped silently (no throw)', async () => {
    await withTmp(async (root) => {
      await put(root, 'present.ts', 'present');

      const { fileHashes } = await hashTrackedFiles(root, [
        src('present.ts'),
        src('missing.ts'),
      ]);
      expect(Object.keys(fileHashes)).toEqual(['present.ts']);
    });
  });

  it('canonical hash is order-independent over plain entries', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'lib/b.ts', 'B');

      const ab = await hashTrackedFiles(root, [src('src'), src('lib')]);
      const ba = await hashTrackedFiles(root, [src('lib'), src('src')]);
      expect(ab.canonicalHash).toBe(ba.canonicalHash);
    });
  });

  it('the canonical hash for a glob entry equals the same set expanded as exact-file entries', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/sub/b.ts', 'B');

      const viaGlob = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      const viaExact = await hashTrackedFiles(root, [src('src/a.ts'), src('src/sub/b.ts')]);

      // The fileHashes maps are identical, so the canonical hashes match
      // (identity is the same EMPTY_IDENTITY in both cases).
      expect(viaGlob.fileHashes).toEqual(viaExact.fileHashes);
      expect(viaGlob.canonicalHash).toBe(viaExact.canonicalHash);
    });
  });
});

describe('hashTrackedFiles — gitignore interplay with globs', () => {
  it('a glob does not match gitignored files', async () => {
    await withTmp(async (root) => {
      await put(root, '.gitignore', 'dist/\n');
      await put(root, 'src/app.ts', 'app');
      await put(root, 'src/dist/bundle.ts', 'bundle');

      const { fileHashes } = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      const keys = Object.keys(fileHashes);

      expect(keys).toContain('src/app.ts');
      expect(keys.some((p) => p.includes('dist'))).toBe(false);
    });
  });
});

describe('hashTrackedFiles — identity fold with globs', () => {
  it('the canonical hash folds the typed identity even with a glob mapping', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      const tracked = [src('src/**/*.ts')];

      const withEmpty = await hashTrackedFiles(root, tracked, undefined, [], EMPTY_IDENTITY);
      const ident: DriftIdentity = { ownSubset: 'own', ports: {}, aspects: { a: { meta: 'm' } } };
      const withIdent = await hashTrackedFiles(root, tracked, undefined, [], ident);

      // Same files, different identity → different canonical hash.
      expect(withIdent.canonicalHash).not.toBe(withEmpty.canonicalHash);
      // But the per-file hashes are identical (identity does not affect file content hashes).
      expect(withIdent.fileHashes).toEqual(withEmpty.fileHashes);
    });
  });

  it('the canonical hash equals computeCanonicalHash over the expanded fileHashes', async () => {
    await withTmp(async (root) => {
      await put(root, 'src/a.ts', 'A');
      await put(root, 'src/b.ts', 'B');

      const { canonicalHash, fileHashes } = await hashTrackedFiles(root, [src('src/**/*.ts')]);
      expect(canonicalHash).toBe(computeCanonicalHash(fileHashes, EMPTY_IDENTITY));
    });
  });
});
