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
 * Resolve a check.mjs-supplied read path to a safe, allow-set-checked repo-relative path.
 * Rejects absolute paths and any `..` traversal that escapes the repo, then enforces the
 * allow-set. Throws UndeclaredFsReadError on any violation. Shared by ctx.fs and ctx.parsers
 * so the two sandbox surfaces cannot diverge.
 */
export function resolveAllowedReadPath(raw: string, allowedSet: Set<string>, projectRoot: string): string {
  const abs = path.resolve(projectRoot, normalizeMappingPath(raw));
  const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
  // rel === '' (the repo root itself), starts with '..' (escapes repo), or is absolute → reject
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UndeclaredFsReadError(normalizeMappingPath(raw));
  }
  if (!isAllowed(rel, allowedSet)) throw new UndeclaredFsReadError(rel);
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
