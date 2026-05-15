import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { type Ignore, type Options as IgnoreOptions } from 'ignore';

const require = createRequire(import.meta.url);
const ignoreFactory = require('ignore') as (options?: IgnoreOptions) => Ignore;

export type GitignoreEntry = { dir: string; ig: Ignore };

const YGGDRASIL_DIRNAME = '.yggdrasil';

export async function loadRootGitignoreStack(projectRoot: string): Promise<GitignoreEntry[]> {
  try {
    const content = await readFile(join(projectRoot, '.gitignore'), 'utf-8');
    const ig = ignoreFactory();
    ig.add(content);
    return [{ dir: projectRoot, ig }];
  } catch {
    return [];
  }
}

export function isIgnoredByStack(absPath: string, stack: GitignoreEntry[]): boolean {
  for (const entry of stack) {
    const rel = relative(entry.dir, absPath);
    if (rel === '' || rel.startsWith('..')) continue;
    const normalized = rel.split(sep).join('/');
    if (entry.ig.ignores(normalized)) return true;
  }
  return false;
}

async function collectFiles(
  dir: string,
  projectRoot: string,
  stack: GitignoreEntry[],
): Promise<string[]> {
  let localStack = stack;
  try {
    const content = await readFile(join(dir, '.gitignore'), 'utf-8');
    const ig = ignoreFactory();
    ig.add(content);
    localStack = [...stack, { dir, ig }];
  } catch {
    // no local .gitignore
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      if (entry.name === YGGDRASIL_DIRNAME && dir === projectRoot) continue;
      if (isIgnoredByStack(absPath, localStack)) continue;
      results.push(...(await collectFiles(absPath, projectRoot, localStack)));
    } else if (entry.isFile()) {
      if (isIgnoredByStack(absPath, localStack)) continue;
      results.push(relative(projectRoot, absPath).split(sep).join('/'));
    }
  }
  return results;
}

/**
 * Walk all files in the repo, returning repo-relative POSIX paths.
 * Excludes `.yggdrasil/`, `.git/`, symlinks, and gitignore-matched files.
 */
export async function walkRepoFiles(projectRoot: string): Promise<string[]> {
  const stack = await loadRootGitignoreStack(projectRoot);
  return collectFiles(projectRoot, projectRoot, stack);
}
