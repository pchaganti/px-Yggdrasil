import { minimatch } from 'minimatch';

/**
 * Canonical mapping-path normalizer shared by the structure fs-gate, the
 * structure file-in-context check, and io/paths mapping expansion. One
 * function so the allowed-reads set and membership tests agree byte-for-byte.
 *
 * Order matters: trim first (strip operator-typed whitespace), then convert
 * backslashes, then strip a single leading './', then strip trailing slashes.
 * A leading './' is a no-op prefix that callers sometimes emit; stripping it
 * keeps './src/a.ts' and 'src/a.ts' in the same equivalence class.
 */
export function normalizeMappingPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** True if a mapping/when path entry contains glob metacharacters. */
export function isGlobPattern(entry: string): boolean {
  return /[*?[\]{}]/.test(entry);
}

/**
 * Does a mapping ENTRY match a repo-relative FILE path?
 *
 * - Glob entry (contains glob metachars): minimatch with { dot: true } — the
 *   same segment-aware semantics as architecture when.path (`*` does not cross
 *   `/`, `**` does).
 * - Plain entry: exact file match OR directory-prefix (entry/...), exactly as
 *   before.
 *
 * Both args are normalized via normalizeMappingPath first.
 */
export function mappingEntryMatchesFile(entry: string, file: string): boolean {
  const e = normalizeMappingPath(entry);
  const f = normalizeMappingPath(file);
  if (e === '') return false;
  if (isGlobPattern(e)) return minimatch(f, e, { dot: true });
  return f === e || f.startsWith(e + '/');
}
