import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FsEntry } from './types.js';

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

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
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

export function createCtxFs(params: CtxFsParams): CtxFs {
  const { allowedSet, projectRoot, touchedFiles } = params;

  function assertAllowed(raw: string): string {
    const p = normalize(raw);
    if (!isAllowed(p, allowedSet)) throw new UndeclaredFsReadError(p);
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
