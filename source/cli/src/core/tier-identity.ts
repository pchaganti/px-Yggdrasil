import type { LlmConfig } from '../model/graph.js';

/**
 * Stable canonical JSON for tier identity. Sorts keys recursively,
 * omits undefined, omits api_key (rotated independently) and timeout
 * (an operational knob — how long to wait for the subprocess — that does
 * not change the reviewer's judgment, so it must not invalidate baselines;
 * including it made tuning the timeout cascade drift across every node).
 *
 * Used by core/graph/files.ts to compute the per-aspect
 * `identity.aspects[id].tier` hash content for drift detection.
 */
export function canonicalTierJson(tier: LlmConfig, tierName: string): string {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  // Excluded fields: api_key (rotated independently), timeout (operational knob —
  // does not change reviewer judgment), max_prompt_chars (a quality gate checked
  // before the LLM call — tuning it must never invalidate recorded baselines).
  const { api_key: _api_key, timeout: _timeout, max_prompt_chars: _max_prompt_chars, ...rest } = tier;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return canonicalJson({ tierName, ...rest });
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
