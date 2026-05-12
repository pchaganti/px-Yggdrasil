import { createHash } from 'node:crypto';
import { parseLog } from '../io/log-parser.js';

export type IntegrityCheck =
  | { ok: true }
  | { ok: false; reason: 'boundary_missing' | 'prefix_modified' };

const DATETIME_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,3}Z$/;

/**
 * Verify the stored baseline (datetime + prefix hash) against current content.
 *
 * Algorithm:
 * 1. Reject if storedDatetime is not strict ISO (defense in depth against tampered baselines).
 * 2. Parse currentContent. Find the entry whose datetime matches storedDatetime.
 *    Missing → boundary_missing.
 * 3. Compute sha256 over bytes [0..entry.offsetEnd). Compare to storedPrefixHash.
 *    Mismatch → prefix_modified.
 * 4. Match → ok.
 */
export function validateAppendOnly(
  currentContent: string,
  storedDatetime: string,
  storedPrefixHash: string,
): IntegrityCheck {
  if (!DATETIME_STRICT.test(storedDatetime)) {
    return { ok: false, reason: 'boundary_missing' };
  }

  const entries = parseLog(currentContent);
  const boundary = entries.find(
    (e) => e.datetime === storedDatetime && DATETIME_STRICT.test(e.datetime),
  );
  if (!boundary) return { ok: false, reason: 'boundary_missing' };

  const bytes = Buffer.from(currentContent, 'utf-8');
  const prefix = bytes.subarray(0, boundary.offsetEnd);
  const computed = createHash('sha256').update(prefix).digest('hex');
  if (computed !== storedPrefixHash) return { ok: false, reason: 'prefix_modified' };

  return { ok: true };
}
