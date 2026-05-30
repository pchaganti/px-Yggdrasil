/**
 * String-level membership test for node mappings. Pure, sync, no I/O.
 * Mapping entries are treated as literal file or directory paths (the same
 * model used by normalizeMappingPaths in io/paths.ts).
 *
 * Used by collectAllowedReadsForAspect to compute the allowed-reads set
 * without async filesystem expansion. Concrete enumeration of files inside
 * mapped dirs happens later, inside the runner, via expandMappingPaths.
 */

// Canonical implementation lives in utils/mapping-path so the structure
// fs-gate (ctx-fs) and the file-in-context check (runner) normalize a path
// identically. Imported for local use by isPathInMapping below and re-exported
// to keep existing structure-module callers importing from a single sibling
// path. (A bare `export { x } from` re-export would not create the local
// binding isPathInMapping needs.)
import { normalizeMappingPath } from '../utils/mapping-path.js';
export { normalizeMappingPath };

/**
 * Test whether a candidate file path is covered by a mapping (set of
 * file/directory patterns). Returns true if candidate exactly matches
 * an entry, or is a descendant of a mapped directory.
 *
 * @param candidate - the path to test (e.g. 'src/lib/b.ts')
 * @param mapping - array of mapping entries (e.g. ['src/lib'])
 */
export function isPathInMapping(candidate: string, mapping: string[]): boolean {
  const c = normalizeMappingPath(candidate);
  if (c === '') return false;
  for (const raw of mapping) {
    const n = normalizeMappingPath(raw);
    if (n === '') continue;
    if (c === n) return true;
    if (c.startsWith(n + '/')) return true; // c is descendant of dir n
  }
  return false;
}
