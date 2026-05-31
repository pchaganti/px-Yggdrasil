import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FsEntry } from './types.js';
import { normalizeMappingPath } from '../utils/mapping-path.js';

export interface CtxFsParams {
  allowedSet: Set<string>;
  projectRoot: string;
  /** mutable list — every fs operation appends the normalized path */
  touchedFiles: string[];
}

export interface CtxFs {
  exists(p: string): 'file' | 'dir' | false;
  list(dir: string): FsEntry[];
  read(p: string): string;
}

export class UndeclaredFsReadError extends Error {
  constructor(public readonly path: string) {
    super(`structure-aspect-undeclared-fs-read: ${path}`);
    this.name = 'UndeclaredFsReadError';
  }
}

function isAllowed(p: string, set: Set<string>): boolean {
  if (p === '') return false;
  if (set.has(p)) return true;
  for (const a of set) {
    if (a === p) return true;
    if (a.startsWith(p + '/')) return true; // p is ancestor dir of allowed file
    if (p.startsWith(a + '/')) return true; // p is descendant of allowed dir/file
  }
  return false;
}

/**
 * Symlink-escape defense. The lexical checks in resolveAllowedReadPath only guard
 * the TEXTUAL path; a symlink inside an allowed path that points OUTSIDE the repo
 * passes them, and the subsequent fs read follows the link out (e.g. an allowed
 * `src/x` that is a symlink to `/etc`). Re-check against the REAL path: realpath
 * the nearest existing ancestor of `abs` and require it to stay within the
 * realpath'd repo root. A non-existent leaf has nothing to follow yet — the
 * lexical check already proved it is textually in-repo, and the read will fail
 * naturally — so only existing ancestors are probed. `projectRoot` itself may sit
 * under a symlink (e.g. /tmp → /private/tmp), so both sides are canonicalized.
 */
function assertRealpathContained(abs: string, projectRoot: string, rel: string): void {
  let realRoot: string;
  try { realRoot = fs.realpathSync(projectRoot); } catch { realRoot = projectRoot; }
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return; // reached the fs root with nothing existing to follow
    probe = parent;
  }
  let realProbe: string;
  try { realProbe = fs.realpathSync(probe); } catch { return; }
  const relReal = path.relative(realRoot, realProbe).replace(/\\/g, '/');
  if (relReal === '..' || relReal.startsWith('../') || path.isAbsolute(relReal)) {
    throw new UndeclaredFsReadError(rel);
  }
}

/**
 * Resolve a check.mjs-supplied read path to a safe, allow-set-checked repo-relative path.
 * Rejects absolute paths and any `..` traversal that escapes the repo, then enforces the
 * allow-set, then re-checks the REAL (symlink-resolved) path is still inside the repo.
 * Throws UndeclaredFsReadError on any violation. Shared by ctx.fs and ctx.parsers so the
 * two allow-set surfaces cannot diverge. (This is a read-tracking discipline, not a
 * security sandbox — check.mjs runs with full Node privileges.)
 */
export function resolveAllowedReadPath(raw: string, allowedSet: Set<string>, projectRoot: string): string {
  const abs = path.resolve(projectRoot, normalizeMappingPath(raw));
  const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
  // rel === '' (the repo root itself), starts with '..' (escapes repo), or is absolute → reject
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UndeclaredFsReadError(normalizeMappingPath(raw));
  }
  if (!isAllowed(rel, allowedSet)) throw new UndeclaredFsReadError(rel);
  // Symlink-escape defense: the textual path is in-repo and allow-listed, but a
  // symlink could still redirect the real read outside the repo. Reject if so.
  assertRealpathContained(abs, projectRoot, rel);
  return rel;
}

export function createCtxFs(params: CtxFsParams): CtxFs {
  const { allowedSet, projectRoot, touchedFiles } = params;

  function assertAllowed(raw: string): string {
    const p = resolveAllowedReadPath(raw, allowedSet, projectRoot);
    touchedFiles.push(p);
    return p;
  }

  return {
    exists(raw) {
      const p = assertAllowed(raw);
      const abs = path.resolve(projectRoot, p);
      try {
        const stat = fs.statSync(abs);
        return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : false;
      } catch {
        return false;
      }
    },

    read(raw) {
      const p = assertAllowed(raw);
      const abs = path.resolve(projectRoot, p);
      return fs.readFileSync(abs, 'utf8');
    },

    list(raw) {
      const p = assertAllowed(raw);
      const abs = path.resolve(projectRoot, p);
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      return entries.map(e => ({
        name: e.name,
        kind: e.isDirectory() ? ('dir' as const) : ('file' as const),
      }));
    },
  };
}
