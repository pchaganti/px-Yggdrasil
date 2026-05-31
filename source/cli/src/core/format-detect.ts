/**
 * Format-version detection predicates consumed by the `to-5.0.0` migration.
 * Pure predicates over raw parsed YAML objects. No I/O.
 *
 * Only two predicates remain after the single-format parser cleanup:
 *   - `isCurrentConfigFormat` — used by the migration to skip already-migrated configs
 *   - `isLegacyAspectReviewer` — used by the migration to detect and rewrite string reviewer fields
 *
 * Runtime parsers operate on the current format only. An old-shape config or
 * aspect yields a generic validation error from the parser; the migration is
 * the only code that understands and transforms old shapes.
 */

export function isCurrentConfigFormat(raw: Record<string, unknown>): boolean {
  const reviewer = raw.reviewer as Record<string, unknown> | undefined;
  return !!reviewer && typeof reviewer === 'object' && !Array.isArray(reviewer) && 'tiers' in reviewer;
}

export function isLegacyAspectReviewer(raw: Record<string, unknown>): boolean {
  return typeof raw.reviewer === 'string';
}
