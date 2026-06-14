/**
 * Compute, for a (fromType → toType) node-type pair, which relation types the
 * architecture's allow-list permits between them.
 *
 * This reuses the SAME source of truth the `relation-target-forbidden` validator
 * reads (`checkArchitectureRelations` in core/checks/architecture.ts): the
 * per-type `relations:` table in yg-architecture.yaml, modelled as
 * `ArchitectureNodeType.relations` — a `Partial<Record<RelationType, string[]>>`
 * mapping each relation type to the node types it may target.
 *
 * Semantics mirror the validator exactly:
 *   - A relation type ABSENT from the `relations:` map is UNCONSTRAINED — it may
 *     target any node type (the validator's `if (!allowedTypes) continue`).
 *   - A relation type PRESENT in the map is allowed only when `toType` is in its
 *     target list (the validator's `allowedTypes.includes(target.type)`).
 *
 * When the `fromType` has no `relations:` table at all, every relation type is
 * unconstrained (the validator skips the node entirely), so all six are allowed.
 */
import type { ArchitectureDef, RelationType } from '../model/graph.js';

/** Canonical relation-type order for stable, deterministic message output. */
export const RELATION_TYPES: readonly RelationType[] = [
  'uses',
  'calls',
  'extends',
  'implements',
  'emits',
  'listens',
];

/**
 * Allowed relation types from `fromType` to `toType` under the architecture's
 * allow-list. Returns them in canonical `RELATION_TYPES` order. An empty array
 * means a dead-end: no relation type may connect those two node types.
 *
 * Unknown node types (not declared in the architecture) yield an empty array —
 * there is no allow-list to consult, so nothing can be sanctioned.
 */
export function allowedRelationTypes(
  architecture: ArchitectureDef,
  fromType: string,
  toType: string,
): RelationType[] {
  const fromConfig = architecture.node_types[fromType];
  if (!fromConfig) return [];
  // An unknown target type cannot be sanctioned by any constrained relation; and
  // an unconstrained relation type would still allow it, so we keep the same
  // per-relation logic below rather than short-circuiting here.
  const relations = fromConfig.relations;

  const out: RelationType[] = [];
  for (const rt of RELATION_TYPES) {
    const allowedTargets = relations?.[rt];
    if (!allowedTargets) {
      // Unconstrained relation type → any target permitted (mirrors validator).
      out.push(rt);
      continue;
    }
    if (allowedTargets.includes(toType)) out.push(rt);
  }
  return out;
}
