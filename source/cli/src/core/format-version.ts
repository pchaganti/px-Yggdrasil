/**
 * Format-version detection for v4 vs v5 yg-config.yaml and yg-aspect.yaml.
 * Pure predicates over raw parsed YAML objects. No I/O.
 */

import { KNOWN_PROVIDERS } from '../io/config-parser.js';

export function isV5ConfigFormat(raw: Record<string, unknown>): boolean {
  const reviewer = raw.reviewer as Record<string, unknown> | undefined;
  return !!reviewer && typeof reviewer === 'object' && !Array.isArray(reviewer) && 'tiers' in reviewer;
}

export function isV4ConfigFormat(raw: Record<string, unknown>): boolean {
  const reviewer = raw.reviewer as Record<string, unknown> | undefined;
  if (!reviewer || typeof reviewer !== 'object' || Array.isArray(reviewer)) return false;
  if (isV5ConfigFormat(raw)) return false;   // mutually exclusive — v5 wins
  return 'active' in reviewer || KNOWN_PROVIDERS.some(p => p in reviewer);
}

export function isV4AspectReviewerString(raw: Record<string, unknown>): boolean {
  return typeof raw.reviewer === 'string';
}

export function isMixedConfigFormat(raw: Record<string, unknown>): boolean {
  const reviewer = raw.reviewer as Record<string, unknown> | undefined;
  if (!reviewer || typeof reviewer !== 'object') return false;
  const hasV5 = 'tiers' in reviewer;
  const hasV4 = 'active' in reviewer || KNOWN_PROVIDERS.some(p => p in reviewer);
  return hasV5 && hasV4;
}
