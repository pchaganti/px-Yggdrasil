import path from 'node:path';

/**
 * Utilities for resolving graph file paths.
 *
 * NOTE (B4 deletion sweep): collectTrackedFiles, buildLayerResolver, emptyIdentity,
 * TrackedFile, TrackedContext — all removed. They were the per-node drift-identity
 * engine; the verdict-lock redesign (B5+) replaces them. The approve pipeline that
 * consumed them is deleted in this same sweep.
 */

/**
 * Repo-relative POSIX path to the .yggdrasil/ graph root (e.g. ".yggdrasil").
 *
 * The SINGLE source of truth for this prefix string. Kept here for any future
 * consumers; the approve pipeline that used it is deleted in B4.
 */
export function yggPrefixOf(graph: { rootPath: string }): string {
  return path.relative(path.dirname(graph.rootPath), graph.rootPath).split(/[\\/]/).join('/');
}
