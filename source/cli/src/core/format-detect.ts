/**
 * Format-version detection for the legacy reviewer shape (pre-tier).
 * Pure predicates over raw parsed YAML objects. No I/O.
 *
 * Migration is the only consumer — runtime parsers operate on the current
 * format only. An old-shape config or aspect yields a generic validation
 * error from the parser; the migration is the only code that understands
 * and transforms old shapes.
 */

import { KNOWN_PROVIDERS } from '../utils/known-providers.js';

export function isCurrentConfigFormat(raw: Record<string, unknown>): boolean {
  const reviewer = raw.reviewer as Record<string, unknown> | undefined;
  return !!reviewer && typeof reviewer === 'object' && !Array.isArray(reviewer) && 'tiers' in reviewer;
}

export function isLegacyConfigFormat(raw: Record<string, unknown>): boolean {
  const reviewer = raw.reviewer as Record<string, unknown> | undefined;
  if (!reviewer || typeof reviewer !== 'object' || Array.isArray(reviewer)) return false;
  if (isCurrentConfigFormat(raw)) return false;
  return 'active' in reviewer || KNOWN_PROVIDERS.some(p => p in reviewer);
}

export function isLegacyAspectReviewer(raw: Record<string, unknown>): boolean {
  return typeof raw.reviewer === 'string';
}

export function isMixedConfigFormat(raw: Record<string, unknown>): boolean {
  const reviewer = raw.reviewer as Record<string, unknown> | undefined;
  if (!reviewer || typeof reviewer !== 'object') return false;
  const hasCurrent = 'tiers' in reviewer;
  const hasLegacy = 'active' in reviewer || KNOWN_PROVIDERS.some(p => p in reviewer);
  return hasCurrent && hasLegacy;
}
