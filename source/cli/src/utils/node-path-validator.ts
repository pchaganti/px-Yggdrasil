import { toPosix } from './posix.js';
export type NodePathValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

/**
 * Validate a CLI `--node` argument against project conventions.
 * Backslashes are normalized to forward slashes before validation.
 * - Must be non-empty.
 * - Must not be absolute (no leading `/`, no `<drive>:/`).
 * - Must not contain `..` segments.
 * - Must not start with `model/` (path is relative to `.yggdrasil/model/`).
 *
 * Returns the normalized path (backslashes → slashes, trailing slash stripped) on success.
 */
export function validateNodePath(raw: string): NodePathValidation {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'Node path is empty' };

  const posix = toPosix(trimmed);

  if (posix.startsWith('/')) {
    return { ok: false, reason: 'Node path must not be absolute (starts with /)' };
  }

  if (/^[A-Za-z]:/.test(posix)) {
    return { ok: false, reason: 'Node path must not be absolute (drive letter)' };
  }

  const segments = posix.split('/');
  if (segments.some((s) => s === '..')) {
    return { ok: false, reason: 'Node path must not contain .. segments' };
  }

  if (segments[0] === 'model') {
    return {
      ok: false,
      reason: 'Node path must not start with model/ — it is implicitly relative to .yggdrasil/model/',
    };
  }

  const normalized = posix.replace(/\/+$/, '');
  if (normalized === '') return { ok: false, reason: 'Node path resolves to empty' };

  return { ok: true, normalized };
}
