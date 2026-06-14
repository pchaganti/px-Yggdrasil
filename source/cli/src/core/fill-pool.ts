/**
 * source/cli/src/core/fill-pool.ts — the bounded worker pool that runs LLM pair
 * fills with at most `concurrency` concurrent evaluations (spec §7).
 *
 * Per-pair throw isolation: a throw from one item becomes a synthetic infra
 * outcome (siblings unaffected) — the pool never aborts. Input order is
 * preserved so the caller can zip outcomes back to the group by index.
 */

import type { LlmFillOutcome } from './fill-shared.js';
import { debugWrite } from '../utils/debug-log.js';

/**
 * Run `fn` over `items` with at most `concurrency` concurrent evaluations,
 * preserving input order. A throw from one item becomes a synthetic infra
 * outcome (siblings unaffected) — never aborts the pool.
 */
export async function runPairPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<LlmFillOutcome>,
): Promise<LlmFillOutcome[]> {
  const results: LlmFillOutcome[] = new Array(items.length);
  const queue = [...items.entries()];
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) break;
      const [i, item] = next;
      try {
        results[i] = await fn(item);
      } catch (e) {
        debugWrite(`[fill] pool worker threw: ${e instanceof Error ? e.message : String(e)}`);
        results[i] = { kind: 'infra', why: `unexpected error during fill: ${e instanceof Error ? e.message : String(e)}`, callsMade: 0 };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
