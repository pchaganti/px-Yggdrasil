import path from 'node:path';

/**
 * Local cache directory for the relation pass's persisted symbol indexes.
 *
 * `graphRootPath` is the `.yggdrasil` directory. The cache lives at
 * `.yggdrasil/.symbols-cache/` — under the graph root, gitignored, and a
 * rebuildable local artifact, never committed. It is a SPEED-only cache: live
 * `yg check` re-parses only the changed files instead of all mapped files; a
 * cold CI run with no cache simply parses everything. Nothing about
 * correctness depends on it (there is no relation-verdict cache to validate).
 * Convention: all Yggdrasil-derived local state lives under `.yggdrasil/`.
 */
export function relationIndexDir(graphRootPath: string): string {
  return path.join(graphRootPath, '.symbols-cache');
}
