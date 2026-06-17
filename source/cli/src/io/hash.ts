import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { type Ignore, type Options as IgnoreOptions } from 'ignore';
import { toPosix, toPosixPath } from '../utils/posix.js';
import { isGlobPattern, mappingEntryMatchesFile, globMatch } from '../utils/mapping-path.js';

export { loadRootGitignoreStack, isIgnoredByStack, walkRepoFiles } from '../io/repo-scanner.js';
export type { GitignoreEntry } from '../io/repo-scanner.js';

const require = createRequire(import.meta.url);
const ignoreFactory = require('ignore') as (options?: IgnoreOptions) => Ignore;

type HashPathOptions = {
  projectRoot?: string;
};

type GitignoreEntry = { basePath: string; matcher: Ignore };

const CR = 0x0d;
const LF = 0x0a;

/**
 * Normalize line endings so the STYLE of line break never affects a content
 * hash: every CRLF (`\r\n`) and every lone CR (`\r`) becomes a single LF (`\n`).
 * The same source checked out with CRLF on Windows and LF on Linux therefore
 * hashes identically — a verdict survives a line-ending change and no spurious
 * re-verification or log-gate prompt is triggered.
 *
 * Operates on raw bytes (CR/LF are ASCII, so this is UTF-8 safe). A buffer with
 * no CR is returned unchanged (byte-identical, same reference). The result is
 * never longer than the input — only used as a hash input, never written back as
 * file content. Binary mapped files are normalized too (a deliberate, harmless
 * trade-off for a single uniform chokepoint — see CHANGELOG 5.0.2).
 */
export function normalizeLineEndings(bytes: Buffer): Buffer {
  if (!bytes.includes(CR)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length);
  let w = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === CR) {
      out[w++] = LF;
      if (bytes[i + 1] === LF) i++; // collapse a CRLF pair into the single LF just written
    } else {
      out[w++] = bytes[i];
    }
  }
  return out.subarray(0, w);
}

/** sha256 hex of a file's content, with line endings normalized (see {@link normalizeLineEndings}). */
export async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return hashBytes(content);
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
      .map((entry) => `${entry.path}:${entry.hash}`)
      .sort()
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

/** sha256 hex of bytes, with line endings normalized (see {@link normalizeLineEndings}). */
export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(normalizeLineEndings(bytes)).digest('hex');
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

/**
 * Collect file paths and mtimes from a directory without hashing.
 * Used by expandMappingPaths and pairs/fingerprint computation.
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
 * Expand a single glob mapping entry into the concrete files it matches.
 *
 * Walks from the glob's base directory — the leading path segments BEFORE the
 * first segment containing a glob metachar (if the first segment is already a
 * glob, the base is projectRoot) — and keeps the entries matching the full
 * pattern (minimatch, { dot: true }, segment-aware). Honors .gitignore via the
 * supplied stack. Returns { relPath (POSIX, relative to projectRoot), absPath,
 * mtimeMs } so callers can both display paths and reuse the mtime without an
 * extra stat. A missing base directory yields an empty list (silent skip).
 *
 * Single source of truth for glob expansion, shared by expandMappingPaths
 * (display/validation) and pairs/fingerprint computation.
 */
async function expandGlobEntry(
  projectRoot: string,
  glob: string,
  gitignoreStack: GitignoreEntry[],
): Promise<Array<{ relPath: string; absPath: string; mtimeMs: number }>> {
  const segments = glob.split('/');
  const firstGlobIdx = segments.findIndex((s) => isGlobPattern(s));
  const baseSegments = firstGlobIdx > 0 ? segments.slice(0, firstGlobIdx) : [];
  const baseDir = baseSegments.length > 0 ? path.join(projectRoot, ...baseSegments) : projectRoot;
  try {
    const dirEntries = await collectDirectoryFilePaths(baseDir, projectRoot, {
      projectRoot,
      gitignoreStack,
    });
    return dirEntries
      .filter((entry) => globMatch(entry.relPath, glob))
      .map((entry) => ({
        relPath: toPosixPath(entry.relPath),
        absPath: entry.absPath,
        mtimeMs: entry.mtimeMs,
      }));
  } catch {
    // Base dir missing — skip
    return [];
  }
}

/**
 * Expand mapping paths to individual file paths.
 * Directories are recursively expanded (respecting .gitignore).
 * Files are returned as-is. Missing paths are silently skipped.
 * Glob entries (containing * ? [ ] { }) are expanded via minimatch against
 * files under the glob's base directory.
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
    if (isGlobPattern(mp)) {
      const entries = await expandGlobEntry(projectRoot, mp, gitignoreStack);
      for (const entry of entries) result.push(entry.relPath);
    } else {
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
  }

  return result;
}

/**
 * Expand mapping paths to individual files, excluding paths matched by any
 * child-mapping exclusion entry. Used by pairs/fingerprint computation.
 */
export async function expandMappingPathsExcluding(
  projectRoot: string,
  mappingPaths: string[],
  excludePrefixes: string[],
): Promise<string[]> {
  const all = await expandMappingPaths(projectRoot, mappingPaths);
  if (!excludePrefixes.length) return all;
  return all.filter(
    (p) => !excludePrefixes.some((prefix) => mappingEntryMatchesFile(prefix, p)),
  );
}
