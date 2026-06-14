import path from 'node:path';

/**
 * Local cache directory for the relation pass's persisted symbol indexes.
 *
 * `graphRootPath` is the `.yggdrasil` directory; its parent is the project root.
 * `.yg-cache` sits at the project root and is gitignored — a rebuildable local
 * cache, never committed. Shared by the fill stage and (later) plain `yg check`
 * so the two always read/write the same location.
 */
export function relationIndexDir(graphRootPath: string): string {
  return path.join(path.dirname(graphRootPath), '.yg-cache');
}
