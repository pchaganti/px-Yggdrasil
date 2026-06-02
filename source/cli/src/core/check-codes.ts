/**
 * Single source of truth for issue-code categories shared between the check
 * engine (core/check.ts — summary tallies) and the check command renderer
 * (cli/check.ts — error grouping). Keeping one definition means the count in the
 * summary line and the rendered "Structural" group can never drift apart, which
 * is exactly what happened when each file hard-coded its own set.
 */

/**
 * Structural validation codes — graph-shape and config errors that always block
 * `yg check` regardless of drift state. Both the summary tally and the rendered
 * grouping read this one set.
 */
export const STRUCTURAL_CODES = new Set<string>([
  'yaml-invalid',
  'type-invalid',
  'relation-broken',
  'flow-node-broken',
  'aspect-undefined',
  'overlapping-mapping',
  'file-duplicate-mapping',
  'structural-cycle',
  'config-invalid',
  'duplicate-aspect-id',
  'node-yaml-missing',
  'implied-aspect-missing',
  'aspect-implies-cycle',
  'event-unpaired',
  'schema-missing',
  'type-without-when-with-mapping',
  'type-when-mismatch',
  'file-mapping-gitignored',
  'enforce-strict-without-when',
  'architecture-cycle',
  'when-predicate-invalid',
  'when-unknown-type',
  'when-unknown-node',
  'when-unknown-port',
  'aspect-unexpected-rule-source',
  'aspect-missing-rule-source',
  'aspect-empty',
  'file-unreadable',
  'aspect-references-on-deterministic',
  'aspect-references-on-aggregate',
  'aspect-reference-broken',
  'aspect-reference-too-large',
  'aspect-references-total-too-large',
  'aspect-reference-invalid-form',
  'aspect-reference-blank-path',
  'aspect-reference-escape',
  'aspect-reference-duplicate',
  'aspect-tier-unknown',
  'mapping-escapes-repo',
]);

/** Completeness codes — non-blocking metadata gaps surfaced in the summary. */
export const COMPLETENESS_CODES = new Set<string>(['description-missing']);
