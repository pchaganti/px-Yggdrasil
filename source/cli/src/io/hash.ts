import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { type Ignore, type Options as IgnoreOptions } from 'ignore';
import type { TrackedFile } from '../core/graph/files.js';
import type { DriftIdentity, AspectIdentity } from '../model/drift.js';
import { toPosix, toPosixPath } from '../utils/posix.js';

export { loadRootGitignoreStack, isIgnoredByStack, walkRepoFiles } from '../io/repo-scanner.js';
export type { GitignoreEntry } from '../io/repo-scanner.js';

const require = createRequire(import.meta.url);
const ignoreFactory = require('ignore') as (options?: IgnoreOptions) => Ignore;

type HashPathOptions = {
  projectRoot?: string;
};

type GitignoreEntry = { basePath: string; matcher: Ignore };

export async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export async function hashPath(targetPath: string, options: HashPathOptions = {}): Promise<string> {
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : undefined;
  const gitignoreStack = await loadRootGitignoreStack(projectRoot);
  const targetStat = await stat(targetPath);

  if (targetStat.isFile()) {
    // Mapped files are always hashed — gitignore only applies to directory scans.
    return hashFile(targetPath);
  }

  if (targetStat.isDirectory()) {
    const fileHashes = await collectDirectoryFileHashes(targetPath, targetPath, {
      projectRoot,
      gitignoreStack,
    });
    const digestInput = fileHashes
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((entry) => `${entry.path}:${entry.hash}`)
      .join('\n');
    return hashString(digestInput);
  }

  throw new Error(`Unsupported mapping path type: ${targetPath}`);
}

async function collectDirectoryFileHashes(
  directoryPath: string,
  rootDirectoryPath: string,
  options: { projectRoot?: string; gitignoreStack?: GitignoreEntry[] },
): Promise<Array<{ path: string; hash: string }>> {
  const filePaths = await collectDirectoryFilePaths(directoryPath, rootDirectoryPath, options);
  const result: Array<{ path: string; hash: string }> = [];
  for (const entry of filePaths) {
    result.push({ path: entry.relPath, hash: await hashFile(entry.absPath) });
  }
  return result;
}

async function loadRootGitignoreStack(projectRoot?: string): Promise<GitignoreEntry[]> {
  if (!projectRoot) return [];
  try {
    const content = await readFile(path.join(projectRoot, '.gitignore'), 'utf-8');
    const matcher = ignoreFactory();
    matcher.add(content);
    return [{ basePath: projectRoot, matcher }];
  } catch {
    return [];
  }
}

function isIgnoredByStack(candidatePath: string, stack: GitignoreEntry[]): boolean {
  for (const { basePath, matcher } of stack) {
    const relativePath = toPosix(path.relative(basePath, candidatePath));
    if (relativePath === '' || relativePath.startsWith('..')) continue;
    if (matcher.ignores(relativePath) || matcher.ignores(relativePath + '/')) return true;
  }
  return false;
}

export function hashString(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Stable, sorted serialization of a record of strings: `key=value` pairs in
 * ascending code-unit key order, joined by `\n`. Reordering insertion does not
 * change the output, so it folds order-independently into the canonical hash.
 */
function serializeStringRecord(record: Record<string, string>): string {
  return Object.keys(record)
    .sort()
    .map((k) => `${k}=${record[k]}`)
    .join('\n');
}

/** Stable serialization of one aspect's identity slice (sorted, fixed field order). */
function serializeAspectIdentity(id: string, ai: AspectIdentity): string {
  const parts: string[] = [`id=${id}`, `meta=${ai.meta}`];
  if (ai.tier !== undefined) parts.push(`tier=${ai.tier}`);
  if (ai.checkTouched !== undefined) {
    parts.push(`checkTouched={${serializeStringRecord(ai.checkTouched)}}`);
  }
  return parts.join('|');
}

/**
 * Stable, sorted serialization of the typed upstream identity. Aspects and
 * ports are sorted by id/target so reordering the maps yields an identical
 * string. `mtimes` and any other non-identity baseline field are NOT included.
 */
export function serializeIdentity(identity: DriftIdentity): string {
  const aspectLines = Object.keys(identity.aspects)
    .sort()
    .map((id) => serializeAspectIdentity(id, identity.aspects[id]))
    .join('\n');
  const portLines = serializeStringRecord(identity.ports);
  return [
    `ownSubset=${identity.ownSubset}`,
    `ports={${portLines}}`,
    `aspects={${aspectLines}}`,
  ].join('\n');
}

/**
 * Compute the canonical drift hash for a baseline from its real-file hashes and
 * typed identity. Deterministic: `files` fold as sorted `path:hash`, `identity`
 * folds via serializeIdentity (sorted at every level). Reordering files,
 * aspects, or ports does not change the result. `mtimes` is never an input.
 *
 * The single source of truth for the canonical hash scheme — both the runtime
 * (hashTrackedFiles) and the re-key transform (drift-state-rekey) call this so
 * a re-keyed baseline over unchanged inputs matches a fresh computation.
 */
export function computeCanonicalHash(
  fileHashes: Record<string, string>,
  identity: DriftIdentity,
): string {
  const filesDigest = Object.entries(fileHashes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, h]) => `${p}:${h}`)
    .join('\n');
  return hashString(`files:\n${filesDigest}\nidentity:\n${serializeIdentity(identity)}`);
}

/** Compute per-file hashes for a mapping. Used for diagnostics (which files changed). */
export async function perFileHashes(
  projectRoot: string,
  mapping: { paths?: string[] },
): Promise<Array<{ path: string; hash: string }>> {
  const root = path.resolve(projectRoot);
  const paths = mapping.paths ?? [];
  if (paths.length === 0) return [];

  const result: Array<{ path: string; hash: string }> = [];
  const gitignoreStack = await loadRootGitignoreStack(root);

  for (const p of paths) {
    const absPath = path.join(root, p);
    const st = await stat(absPath);
    if (st.isFile()) {
      result.push({ path: toPosixPath(p), hash: await hashFile(absPath) });
    } else if (st.isDirectory()) {
      const hashes = await collectDirectoryFileHashes(absPath, absPath, {
        projectRoot: root,
        gitignoreStack,
      });
      for (const h of hashes) {
        result.push({
          path: toPosixPath(path.join(p, h.path)),
          hash: h.hash,
        });
      }
    }
  }

  return result;
}

/** Compute drift hash for a node mapping. Returns hex. */
export async function hashForMapping(
  projectRoot: string,
  mapping: { paths?: string[] },
): Promise<string> {
  const root = path.resolve(projectRoot);
  const paths = mapping.paths ?? [];
  if (paths.length === 0) throw new Error('Invalid mapping for hash: no paths');

  const pairs: Array<{ path: string; hash: string }> = [];

  for (const p of paths) {
    const absPath = path.join(root, p);
    const st = await stat(absPath);
    if (st.isFile()) {
      pairs.push({ path: toPosixPath(p), hash: await hashFile(absPath) });
    } else if (st.isDirectory()) {
      const dirHash = await hashPath(absPath, { projectRoot: root });
      pairs.push({ path: toPosixPath(p), hash: dirHash });
    }
  }

  const digestInput = pairs
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => `${e.path}:${e.hash}`)
    .join('\n');
  return createHash('sha256').update(digestInput).digest('hex');
}

/** Stored file data for mtime-based drift optimization. */
export interface StoredFileData {
  hashes: Record<string, string>;
  mtimes: Record<string, number>;
}

/** Empty identity — folded when a caller hashes files without an upstream identity. */
const EMPTY_IDENTITY: DriftIdentity = { ownSubset: hashString(''), ports: {}, aspects: {} };

/**
 * Hash all tracked files (source + graph) for bidirectional drift detection.
 * Directories in the tracked list are expanded to their contained files.
 * Returns a canonical hash (files digest + typed identity folded), per-file
 * hashes, and mtimes.
 *
 * When `storedFileData` is provided, files whose mtime has not changed since
 * the last sync will reuse the stored hash instead of re-reading and hashing.
 * This makes the common case (no changes) nearly instant even for large mappings.
 *
 * `identity` is folded into the canonical hash via computeCanonicalHash. Pass
 * the node's typed identity when computing a baseline-comparable hash; omit it
 * (e.g. when only the per-file source map is needed) to fold an empty identity.
 * `mtimes` is never part of the canonical hash.
 */
export async function hashTrackedFiles(
  projectRoot: string,
  trackedFiles: TrackedFile[],
  storedFileData?: StoredFileData,
  excludePrefixes?: string[],
  identity?: DriftIdentity,
): Promise<{ canonicalHash: string; fileHashes: Record<string, string>; fileMtimes: Record<string, number> }> {
  const fileHashes: Record<string, string> = {};
  const fileMtimes: Record<string, number> = {};
  const gitignoreStack = await loadRootGitignoreStack(projectRoot);

  // Collect all file entries (expanding directories) with their metadata
  type FileEntry = { relPath: string; absPath: string; mtimeMs: number };
  const allFiles: FileEntry[] = [];

  for (const tf of trackedFiles) {
    const absPath = path.join(projectRoot, tf.path);
    try {
      const st = await stat(absPath);
      if (st.isDirectory()) {
        const dirEntries = await collectDirectoryFilePaths(absPath, absPath, {
          projectRoot,
          gitignoreStack,
        });
        for (const entry of dirEntries) {
          allFiles.push({
            relPath: toPosixPath(path.join(tf.path, entry.relPath)),
            absPath: entry.absPath,
            mtimeMs: entry.mtimeMs,
          });
        }
      } else {
        allFiles.push({ relPath: tf.path, absPath, mtimeMs: st.mtimeMs });
      }
    } catch {
      continue;
    }
  }

  // Exclude files owned by descendant nodes (child-wins model)
  const filtered = excludePrefixes?.length
    ? allFiles.filter((entry) =>
        !excludePrefixes.some((prefix) =>
          entry.relPath === prefix || entry.relPath.startsWith(prefix + '/')))
    : allFiles;

  // Separate files into cached (mtime match) and dirty (need hashing)
  const dirty: FileEntry[] = [];
  for (const entry of filtered) {
    const storedMtime = storedFileData?.mtimes[entry.relPath];
    const storedHash = storedFileData?.hashes[entry.relPath];
    if (storedMtime !== undefined && storedHash !== undefined && entry.mtimeMs === storedMtime) {
      fileHashes[entry.relPath] = storedHash;
    } else {
      dirty.push(entry);
    }
    fileMtimes[entry.relPath] = entry.mtimeMs;
  }

  // Hash dirty files in parallel batches to avoid overwhelming file descriptors
  const BATCH_SIZE = 256;
  for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
    const batch = dirty.slice(i, i + BATCH_SIZE);
    const hashes = await Promise.all(batch.map((e) => hashFile(e.absPath)));
    for (let j = 0; j < batch.length; j++) {
      fileHashes[batch[j].relPath] = hashes[j];
    }
  }

  // Canonical hash: real-file digest + typed identity, via the single-source-of-truth fold.
  const canonicalHash = computeCanonicalHash(fileHashes, identity ?? EMPTY_IDENTITY);

  return { canonicalHash, fileHashes, fileMtimes };
}

/**
 * Collect file paths and mtimes from a directory without hashing.
 * Used by hashTrackedFiles to separate discovery from hashing,
 * enabling mtime-based optimization.
 *
 * Directory recursion and file stat() calls are parallelized for performance.
 */
async function collectDirectoryFilePaths(
  directoryPath: string,
  rootDirectoryPath: string,
  options: { projectRoot?: string; gitignoreStack?: GitignoreEntry[] },
): Promise<Array<{ relPath: string; absPath: string; mtimeMs: number }>> {
  let stack = options.gitignoreStack ?? [];
  try {
    const localContent = await readFile(path.join(directoryPath, '.gitignore'), 'utf-8');
    const localMatcher = ignoreFactory();
    localMatcher.add(localContent);
    stack = [...stack, { basePath: directoryPath, matcher: localMatcher }];
  } catch {
    // No local .gitignore
  }

  const entries = await readdir(directoryPath, { withFileTypes: true });
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    const absoluteChildPath = path.join(directoryPath, entry.name);
    if (isIgnoredByStack(absoluteChildPath, stack)) continue;
    if (entry.isDirectory()) dirs.push(absoluteChildPath);
    else if (entry.isFile()) files.push(absoluteChildPath);
  }

  // Parallel: recurse into directories AND stat files concurrently
  const [dirResults, fileStats] = await Promise.all([
    Promise.all(dirs.map((d) => collectDirectoryFilePaths(d, rootDirectoryPath, {
      projectRoot: options.projectRoot,
      gitignoreStack: stack,
    }))),
    Promise.all(files.map(async (f) => {
      const fileStat = await stat(f);
      return {
        relPath: toPosixPath(path.relative(rootDirectoryPath, f)),
        absPath: f,
        mtimeMs: fileStat.mtimeMs,
      };
    })),
  ]);

  const result: Array<{ relPath: string; absPath: string; mtimeMs: number }> = [];
  for (const nested of dirResults) result.push(...nested);
  result.push(...fileStats);
  return result;
}

/**
 * Expand mapping paths to individual file paths.
 * Directories are recursively expanded (respecting .gitignore).
 * Files are returned as-is. Missing paths are silently skipped.
 *
 * Returns relative paths (forward-slash normalized) suitable for display.
 */
export async function expandMappingPaths(
  projectRoot: string,
  mappingPaths: string[],
): Promise<string[]> {
  const gitignoreStack = await loadRootGitignoreStack(projectRoot);
  const result: string[] = [];

  for (const mp of mappingPaths) {
    const absPath = path.join(projectRoot, mp);
    try {
      const st = await stat(absPath);
      if (st.isDirectory()) {
        const dirEntries = await collectDirectoryFilePaths(absPath, absPath, {
          projectRoot,
          gitignoreStack,
        });
        for (const entry of dirEntries) {
          result.push(toPosixPath(path.join(mp, entry.relPath)));
        }
      } else {
        result.push(toPosixPath(mp));
      }
    } catch {
      // Missing path — skip
      continue;
    }
  }

  return result;
}
