/**
 * POSIX path helpers — the single home for the "normalize path separators to
 * forward slash" idiom that was previously hand-inlined across the codebase.
 *
 * Keeping it in one place means the normalization rule (and any future change to
 * it) lives in exactly one spot, and call sites read by intent rather than by a
 * repeated regex. The `deterministic` graph stays the source of truth for paths
 * that flow into output or comparison.
 */

/**
 * Convert any backslash path separators to forward slashes. No other changes —
 * a trailing slash, if present, is preserved.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Normalize a path to POSIX form for output, storage, or comparison: forward-
 * slash separators AND no trailing slash(es). Use this wherever a path is
 * written to stdout/stderr, stored in graph outputs, or compared, so consumers
 * never receive a Windows-native separator or a dangling trailing slash.
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}
