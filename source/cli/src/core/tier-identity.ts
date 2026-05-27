import type { LlmConfig } from '../model/graph.js';

/**
 * Stable canonical JSON for tier identity. Sorts keys recursively,
 * omits undefined, omits api_key (rotated independently).
 *
 * Used by core/graph/files.ts to compute the synthetic
 * `tier-identity:<aspectId>` content for drift detection.
 */
export function canonicalTierJson(tier: LlmConfig, tierName: string): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { api_key: _api_key, ...rest } = tier;
  return canonicalJson({ tierName, ...rest });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
