import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  cpSync,
  readFileSync,
} from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandMappingPaths, hashTrackedFiles } from '../../../src/io/hash.js';
import type { TrackedFile } from '../../../src/core/graph/files.js';

// ---------------------------------------------------------------------------
// TARGET: expandMappingPaths / expandGlobEntry / collectDirectoryFilePaths
// (src/io/hash.ts). expandGlobEntry and collectDirectoryFilePaths are private;
// they are reached through the two exported surfaces that call them:
//   - expandMappingPaths(projectRoot, mappingPaths) — directory/file/glob/missing
//   - hashTrackedFiles(projectRoot, trackedFiles, ...) — the glob branch calls
//     expandGlobEntry directly; the directory branch calls collectDirectoryFilePaths.
//
// Every test builds a fresh temp tree via mkdtemp(os.tmpdir()) and rm()'s it in
// a finally. No repo files, no src/, no .yggdrasil/ are touched. No randomness;
// the wall clock is never read inside an assertion.
// ---------------------------------------------------------------------------

/** Build a fresh temp project root for an async test, run body, clean up. */
async function withTempRoot(label: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `yg-bounty2-${label}-`));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Create a file (with parent dirs) under root at a POSIX-relative path. */
async function touch(root: string, rel: string, content = 'x'): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

const sorted = (a: string[]): string[] => [...a].sort();

// ===========================================================================
// expandMappingPaths — top-level branch matrix
// ===========================================================================

describe('expandMappingPaths — non-glob entry: directory (isDirectory true) recursive expand', () => {
  it('expands a directory to all contained files (recursively), prefixing the mapping path', async () => {
    await withTempRoot('dir-recursive', async (root) => {
      await touch(root, 'src/a.ts');
      await touch(root, 'src/sub/b.ts');
      await touch(root, 'src/sub/deep/c.ts');

      const out = await expandMappingPaths(root, ['src']);
      expect(sorted(out)).toEqual(sorted(['src/a.ts', 'src/sub/b.ts', 'src/sub/deep/c.ts']));
    });
  });

  it('returns an empty list for an empty directory (collectDirectoryFilePaths with no entries)', async () => {
    await withTempRoot('dir-empty', async (root) => {
      await mkdir(path.join(root, 'empty'), { recursive: true });
      const out = await expandMappingPaths(root, ['empty']);
      expect(out).toEqual([]);
    });
  });
});

describe('expandMappingPaths — non-glob entry: file (isFile, NOT directory) returned as-is', () => {
  it('returns the single file path normalized to POSIX, unchanged otherwise', async () => {
    await withTempRoot('file-asis', async (root) => {
      await touch(root, 'src/index.ts');
      const out = await expandMappingPaths(root, ['src/index.ts']);
      expect(out).toEqual(['src/index.ts']);
    });
  });

  it('returns a nested file entry as-is (isFile else branch) without expanding siblings', async () => {
    await withTempRoot('file-nested', async (root) => {
      await touch(root, 'src/deep/target.ts');
      await touch(root, 'src/deep/other.ts'); // a sibling — must NOT appear
      // A direct file entry hits stat().isDirectory()===false → pushed via
      // toPosixPath(mp), with no directory expansion of the parent.
      const out = await expandMappingPaths(root, ['src/deep/target.ts']);
      expect(out).toEqual(['src/deep/target.ts']);
    });
  });
});

describe('expandMappingPaths — non-glob entry: missing path (stat throws) is silently skipped', () => {
  it('skips a missing path and keeps the surviving entries', async () => {
    await withTempRoot('missing-skip', async (root) => {
      await touch(root, 'src/real.ts');
      const out = await expandMappingPaths(root, ['src/does-not-exist.ts', 'src/real.ts']);
      // The missing entry contributes nothing; the real one survives.
      expect(out).toEqual(['src/real.ts']);
    });
  });

  it('returns an empty list when every non-glob entry is missing', async () => {
    await withTempRoot('missing-all', async (root) => {
      const out = await expandMappingPaths(root, ['nope/a.ts', 'nope/b.ts']);
      expect(out).toEqual([]);
    });
  });
});

// ===========================================================================
// expandGlobEntry — firstGlobIdx > 0 (base = leading segments)
// ===========================================================================

describe('expandGlobEntry via expandMappingPaths — firstGlobIdx > 0 (base = leading segments)', () => {
  it('single-segment * matches files in exactly the base dir, not subdirectories', async () => {
    await withTempRoot('glob-base-leading', async (root) => {
      await touch(root, 'src/db/FooRepository.cs');
      await touch(root, 'src/db/BarRepository.cs');
      await touch(root, 'src/db/Helper.cs'); // does not match *Repository.cs
      await touch(root, 'src/db/sub/SubRepository.cs'); // * does not cross '/'

      const out = await expandMappingPaths(root, ['src/db/*Repository.cs']);
      expect(sorted(out)).toEqual(sorted(['src/db/FooRepository.cs', 'src/db/BarRepository.cs']));
    });
  });

  it('** crosses path separators under the leading-segment base', async () => {
    await withTempRoot('glob-globstar', async (root) => {
      await touch(root, 'src/a.ts');
      await touch(root, 'src/x/b.ts');
      await touch(root, 'src/x/y/c.ts');
      await touch(root, 'src/note.md'); // not .ts → dropped

      const out = await expandMappingPaths(root, ['src/**/*.ts']);
      expect(sorted(out)).toEqual(sorted(['src/a.ts', 'src/x/b.ts', 'src/x/y/c.ts']));
    });
  });
});

// ===========================================================================
// expandGlobEntry — firstGlobIdx === 0 (base = projectRoot)
// ===========================================================================

describe('expandGlobEntry via expandMappingPaths — firstGlobIdx === 0 (base = projectRoot)', () => {
  it('a pattern whose FIRST segment is a glob walks from projectRoot', async () => {
    await withTempRoot('glob-base-root', async (root) => {
      await touch(root, 'top.ts');
      await touch(root, 'nested/deep.ts');
      await touch(root, 'nested/readme.md'); // not .ts → dropped

      // First segment '**' is a glob → baseDir = projectRoot.
      const out = await expandMappingPaths(root, ['**/*.ts']);
      expect(sorted(out)).toEqual(sorted(['top.ts', 'nested/deep.ts']));
    });
  });

  it('a leading single-segment * (firstGlobIdx === 0) walks from projectRoot and respects segment boundary', async () => {
    await withTempRoot('glob-leading-star', async (root) => {
      await touch(root, 'alpha.ts');
      await touch(root, 'beta.ts');
      await touch(root, 'dir/gamma.ts'); // * does not cross '/', so this is dropped

      const out = await expandMappingPaths(root, ['*.ts']);
      expect(sorted(out)).toEqual(sorted(['alpha.ts', 'beta.ts']));
    });
  });
});

// ===========================================================================
// expandGlobEntry — base dir missing -> []
// ===========================================================================

describe('expandGlobEntry via expandMappingPaths — missing base directory yields []', () => {
  it('a glob whose leading-segment base directory does not exist contributes nothing', async () => {
    await withTempRoot('glob-missing-base', async (root) => {
      await touch(root, 'src/real.ts');
      // base dir "ghostdir" does not exist → collectDirectoryFilePaths throws →
      // expandGlobEntry catches and returns []. The real entry still survives.
      const out = await expandMappingPaths(root, ['ghostdir/**/*.ts', 'src/real.ts']);
      expect(out).toEqual(['src/real.ts']);
    });
  });

  it('a glob whose base dir is missing returns an empty list overall when it is the only entry', async () => {
    await withTempRoot('glob-missing-base-only', async (root) => {
      const out = await expandMappingPaths(root, ['ghostdir/*.ts']);
      expect(out).toEqual([]);
    });
  });
});

// ===========================================================================
// expandGlobEntry — minimatch filter: keeps matching / drops non-matching
// ===========================================================================

describe('expandGlobEntry via expandMappingPaths — minimatch filter keeps/drops', () => {
  it('keeps only the entries that satisfy the full pattern, dropping the rest', async () => {
    await withTempRoot('glob-filter', async (root) => {
      await touch(root, 'src/keep1.ts');
      await touch(root, 'src/keep2.ts');
      await touch(root, 'src/drop.js'); // wrong extension → dropped
      await touch(root, 'src/drop.tsx'); // .tsx is not .ts → dropped

      const out = await expandMappingPaths(root, ['src/*.ts']);
      expect(sorted(out)).toEqual(sorted(['src/keep1.ts', 'src/keep2.ts']));
    });
  });

  it('a glob with dot:true matches a leading-dot segment (collectDirectoryFilePaths surfaces dotfiles)', async () => {
    await withTempRoot('glob-dot', async (root) => {
      await touch(root, 'src/.hidden/file.ts');
      await touch(root, 'src/visible.ts');

      const out = await expandMappingPaths(root, ['src/**/*.ts']);
      // { dot: true } in globMatch → the dot segment is matched like any other.
      expect(sorted(out)).toEqual(sorted(['src/.hidden/file.ts', 'src/visible.ts']));
    });
  });
});

// ===========================================================================
// collectDirectoryFilePaths / isIgnoredByStack — gitignore exclusion
// ===========================================================================

describe('collectDirectoryFilePaths via expandMappingPaths — .gitignore exclusion', () => {
  it('a ROOT .gitignore (loadRootGitignoreStack) excludes a matching directory-scan file', async () => {
    await withTempRoot('gitignore-root', async (root) => {
      await touch(root, '.gitignore', 'ignored.ts\n');
      await touch(root, 'src/ignored.ts');
      await touch(root, 'src/kept.ts');

      const out = await expandMappingPaths(root, ['src']);
      // The root stack matches 'src/ignored.ts' relative to root → excluded.
      expect(out).toEqual(['src/kept.ts']);
    });
  });

  it('a LOCAL .gitignore inside the scanned directory extends the stack and excludes a file', async () => {
    await withTempRoot('gitignore-local', async (root) => {
      await touch(root, 'pkg/.gitignore', 'secret.ts\n');
      await touch(root, 'pkg/secret.ts');
      await touch(root, 'pkg/public.ts');

      const out = await expandMappingPaths(root, ['pkg']);
      // The local .gitignore (basePath = pkg dir) ignores 'secret.ts'. The
      // .gitignore file itself is a real file not matched by its own pattern,
      // so it is included in the directory scan.
      expect(sorted(out)).toEqual(sorted(['pkg/.gitignore', 'pkg/public.ts']));
    });
  });

  it('an ignored sub-directory removes all of its files from a recursive scan', async () => {
    await withTempRoot('gitignore-dir', async (root) => {
      await touch(root, '.gitignore', 'node_modules/\n');
      await touch(root, 'src/main.ts');
      await touch(root, 'node_modules/dep/index.ts');

      const out = await expandMappingPaths(root, ['.']);
      // node_modules/ is ignored as a directory; '.gitignore' itself is a real
      // file but is NOT ignored by these patterns, so it is included.
      expect(sorted(out)).toEqual(sorted(['.gitignore', 'src/main.ts']));
    });
  });

  it('no .gitignore anywhere (catch branches taken) includes every file', async () => {
    await withTempRoot('gitignore-none', async (root) => {
      await touch(root, 'src/one.ts');
      await touch(root, 'src/two.ts');

      const out = await expandMappingPaths(root, ['src']);
      expect(sorted(out)).toEqual(sorted(['src/one.ts', 'src/two.ts']));
    });
  });

  it('a glob expansion also honors .gitignore exclusion (expandGlobEntry path)', async () => {
    await withTempRoot('gitignore-glob', async (root) => {
      await touch(root, '.gitignore', 'build/\n');
      await touch(root, 'lib/a.ts');
      await touch(root, 'build/generated.ts'); // under ignored build/

      const out = await expandMappingPaths(root, ['**/*.ts']);
      expect(out).toEqual(['lib/a.ts']);
    });
  });
});

// ===========================================================================
// collectDirectoryFilePaths — directory vs file entry classification
// (entry.isDirectory recurse / entry.isFile stat). A directory that holds only
// a sub-directory exercises the "recurse, no files at this level" path.
// ===========================================================================

describe('collectDirectoryFilePaths via expandMappingPaths — mixed dir/file children', () => {
  it('classifies files and recurses into directories, ignoring nothing extra', async () => {
    await withTempRoot('mixed', async (root) => {
      await touch(root, 'm/file-at-top.ts');
      await touch(root, 'm/childdir/nested.ts');
      // A directory whose only content is another directory (no files at its level).
      await touch(root, 'm/onlydirs/inner/leaf.ts');

      const out = await expandMappingPaths(root, ['m']);
      expect(sorted(out)).toEqual(
        sorted(['m/file-at-top.ts', 'm/childdir/nested.ts', 'm/onlydirs/inner/leaf.ts']),
      );
    });
  });
});

// ===========================================================================
// hashTrackedFiles — reaches expandGlobEntry DIRECTLY (the isGlobPattern branch)
// and collectDirectoryFilePaths (the directory branch). This pins both private
// helpers through the second exported surface, including firstGlobIdx === 0.
// ===========================================================================

const tf = (p: string): TrackedFile => ({ path: p, category: 'source', layer: 'source' });

describe('hashTrackedFiles — glob tracked entry expands via expandGlobEntry', () => {
  it('a glob tracked path yields per-file hashes for each matched file (firstGlobIdx > 0)', async () => {
    await withTempRoot('htf-glob-leading', async (root) => {
      await touch(root, 'src/a.ts', 'aaa');
      await touch(root, 'src/b.ts', 'bbb');
      await touch(root, 'src/skip.md', 'mmm');

      const { fileHashes } = await hashTrackedFiles(root, [tf('src/*.ts')]);
      expect(sorted(Object.keys(fileHashes))).toEqual(sorted(['src/a.ts', 'src/b.ts']));
    });
  });

  it('a leading-glob tracked path (firstGlobIdx === 0) walks from projectRoot', async () => {
    await withTempRoot('htf-glob-root', async (root) => {
      await touch(root, 'one.ts', '1');
      await touch(root, 'deep/two.ts', '2');
      await touch(root, 'deep/three.md', '3');

      const { fileHashes } = await hashTrackedFiles(root, [tf('**/*.ts')]);
      expect(sorted(Object.keys(fileHashes))).toEqual(sorted(['one.ts', 'deep/two.ts']));
    });
  });

  it('a glob tracked entry with a missing base dir contributes zero files (expandGlobEntry catch → [])', async () => {
    await withTempRoot('htf-glob-missing', async (root) => {
      await touch(root, 'real/x.ts', 'x');
      const { fileHashes } = await hashTrackedFiles(root, [tf('ghost/*.ts'), tf('real/x.ts')]);
      expect(sorted(Object.keys(fileHashes))).toEqual(sorted(['real/x.ts']));
    });
  });

  it('a directory tracked entry expands via collectDirectoryFilePaths, prefixing the entry path', async () => {
    await withTempRoot('htf-dir', async (root) => {
      await touch(root, 'pkg/a.ts', 'a');
      await touch(root, 'pkg/sub/b.ts', 'b');
      const { fileHashes } = await hashTrackedFiles(root, [tf('pkg')]);
      expect(sorted(Object.keys(fileHashes))).toEqual(sorted(['pkg/a.ts', 'pkg/sub/b.ts']));
    });
  });

  it('a plain FILE tracked entry is hashed as-is (non-directory else branch)', async () => {
    await withTempRoot('htf-file', async (root) => {
      await touch(root, 'only.ts', 'content');
      const { fileHashes } = await hashTrackedFiles(root, [tf('only.ts')]);
      expect(Object.keys(fileHashes)).toEqual(['only.ts']);
    });
  });

  it('a missing non-glob tracked entry is skipped (stat throws → catch continue)', async () => {
    await withTempRoot('htf-missing', async (root) => {
      await touch(root, 'present.ts', 'p');
      const { fileHashes } = await hashTrackedFiles(root, [tf('absent.ts'), tf('present.ts')]);
      expect(Object.keys(fileHashes)).toEqual(['present.ts']);
    });
  });
});

// ===========================================================================
// E2E — the glob expansion is reachable through the CLI. `yg owner` resolves a
// repo-relative file to its owning node; a node mapped ONLY by a glob proves the
// expansion runs end-to-end inside the spawned binary. Modeled on
// tests/e2e/cli-architecture-when-validation.test.ts (copy of e2e-lifecycle).
// ===========================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty2-e2e-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const ordersNodePath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');

describe.skipIf(!distExists)('E2E — glob mapping expansion through the spawned yg CLI', () => {
  it('E1: `yg owner` resolves a file owned by a node mapped ONLY via a glob', () => {
    const dir = copyFixture('owner-glob');
    try {
      // Re-map the orders node from the literal file to a glob that matches it.
      // expandGlobEntry/collectDirectoryFilePaths must run inside the binary to
      // resolve src/services/orders.ts back to the orders node.
      const y = readFileSync(ordersNodePath(dir), 'utf-8').replace(
        'src/services/orders.ts',
        'src/services/order*.ts',
      );
      writeFileSync(ordersNodePath(dir), y, 'utf-8');

      const { all, status } = run(['owner', '--file', 'src/services/orders.ts'], dir);
      // The glob expanded to the real file, so the CLI identifies the owning node.
      expect(all).toContain('src/services/orders.ts -> services/orders');
      // owner of an existing mapped file succeeds.
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E2: a glob-only node whose matched file exists does NOT report "never created"', () => {
    const dir = copyFixture('check-glob');
    try {
      const y = readFileSync(ordersNodePath(dir), 'utf-8').replace(
        'src/services/orders.ts',
        'src/services/order*.ts',
      );
      writeFileSync(ordersNodePath(dir), y, 'utf-8');

      const { all } = run(['check'], dir);
      // The glob expansion finds orders.ts on disk → no "source never created".
      expect(all).not.toContain('never created');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
