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
