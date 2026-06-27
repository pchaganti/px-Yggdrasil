/**
 * Cache-audit harness for the relation pass.
 *
 * A forgotten cache-key ingredient or a broken (de)serialization fails SILENTLY as a
 * false green: a file whose cached facts differ from the freshly-parsed facts would
 * produce the same `violationsByNode` output but through stale data — the gate stays
 * green even though the cache is lying. This harness is the standing proof that the
 * cache is honest.
 *
 * ## Warm-then-A/B protocol
 *
 * 1. **Warm** — run the pass with the cache enabled. Shards are written on MISS
 *    (first run over a temp dir → every file misses → shards are written).
 * 2. **A (cache-HIT run)** — run again with the cache enabled. Every file now hits
 *    the shard; facts come back through `loadFacts` + `deserialize`.
 * 3. **B (cache-DISABLED run)** — run with `disableCache: true`. Every file is
 *    parsed fresh; `loadFacts`/`writeFacts` are never called.
 * 4. Assert deep-equal: A.factsByPath === B.factsByPath AND
 *    A.violationsByNode === B.violationsByNode.
 *
 * A mismatch in (4) means either:
 *   - an incomplete cache key (a key ingredient was omitted, so a stale shard was
 *     returned for a changed file), OR
 *   - a broken serialize/deserialize round-trip (data written to disk does not
 *     survive the JSON round-trip faithfully — the canonical C# `Map` trap).
 *
 * Comparing a **cache-HIT run against a cache-DISABLED run** is what exercises the
 * serialize/deserialize path and key completeness. A cold-vs-disabled comparison
 * would prove nothing — both would parse fresh and trivially agree.
 */
import type { Graph } from '../model/graph.js';
import { runRelationPass, type RelationPassDeps, type FileFacts, type NodeViolations } from './pass.js';

export interface AuditResult {
  /** Whether the audit passed (A facts == B facts AND A violations == B violations). */
  pass: boolean;
  /** Per-file diffs between the cache-HIT run (A) and the cache-DISABLED run (B). */
  factsDiffs: Array<{ path: string; a: FileFacts | null; b: FileFacts | null; reason: string }>;
  /** Per-node violation diffs between runs A and B. */
  violationDiffs: Array<{
    nodeId: string;
    a: NodeViolations | undefined;
    b: NodeViolations | undefined;
    reason: string;
  }>;
}

/**
 * Run the relation-pass cache audit over the given graph/project.
 *
 * Performs three passes (warm → A → B) and returns a structured diff. The caller
 * asserts `result.pass === true`; the `factsDiffs` / `violationDiffs` arrays carry
 * the specific mismatches on failure so the assertion message is actionable.
 *
 * @param graph       The in-memory graph describing nodes and their file mappings.
 * @param projectRoot Absolute path to the project root (files are read from here).
 * @param deps        Relay deps (extractorFor, resolvePathToFile). `symbolIndexDir`
 *                    MUST point to a fresh/empty directory so the warm pass writes
 *                    from scratch and the A pass exercises real cache hits.
 *                    `disableCache` from deps is IGNORED — the audit controls it.
 */
export async function runCacheAudit(
  graph: Graph,
  projectRoot: string,
  deps: Omit<RelationPassDeps, 'disableCache'>,
): Promise<AuditResult> {
  const baseDeps: RelationPassDeps = { ...deps };

  // Phase 1: Warm — first pass over a fresh cache dir. Every file misses → shards written.
  await runRelationPass(graph, projectRoot, { ...baseDeps, disableCache: false });

  // Phase 2: A — cache-HIT run. Every file hits its shard; facts come through
  // loadFacts + deserialize. This is the run that exercises the round-trip.
  const runA = await runRelationPass(graph, projectRoot, { ...baseDeps, disableCache: false });

  // Phase 3: B — cache-DISABLED run. Every file is parsed fresh; no shard I/O.
  const runB = await runRelationPass(graph, projectRoot, { ...baseDeps, disableCache: true });

  // Compare per-file facts (A vs B).
  const factsDiffs: AuditResult['factsDiffs'] = [];
  const allPaths = new Set([...runA.factsByPath.keys(), ...runB.factsByPath.keys()]);
  for (const p of allPaths) {
    /* v8 ignore next 3 -- ??null branches fire only when runs have asymmetric files (pathological) */
    const a = runA.factsByPath.get(p) ?? null;
    const b = runB.factsByPath.get(p) ?? null;
    /* v8 ignore next -- failure path; exercised by deliberate-break sanity check only */
    if (!deepEqual(a, b)) factsDiffs.push({ path: p, a, b, reason: diffReason(a, b) });
  }

  // Compare per-node violations (A vs B).
  const violationDiffs: AuditResult['violationDiffs'] = [];
  const allNodes = new Set([...runA.violationsByNode.keys(), ...runB.violationsByNode.keys()]);
  for (const nodeId of allNodes) {
    const a = runA.violationsByNode.get(nodeId);
    const b = runB.violationsByNode.get(nodeId);
    /* v8 ignore next -- failure path; exercised by deliberate-break sanity check only */
    if (!deepEqual(a, b)) violationDiffs.push({ nodeId, a, b, reason: diffReason(a, b) });
  }

  return {
    pass: factsDiffs.length === 0 && violationDiffs.length === 0,
    factsDiffs,
    violationDiffs,
  };
}

/**
 * Structural deep equality via JSON round-trip.
 *
 * This deliberately uses `JSON.stringify` for comparison — the SAME serialization
 * path that the on-disk shard uses. A `Map` that survives JSON as `{}` (the C# alias
 * trap) would produce an empty serialization in BOTH runs, hiding the mismatch. But
 * after `loadFacts` rebuilds the `Map`s from entry arrays, the in-memory `FileFacts`
 * in run A carries the LIVE reconstructed `Map`s — so `JSON.stringify` on the A-side
 * fact would also serialize them as `{}` if we didn't use `replacer`.
 *
 * We therefore normalize `Map`s → `[...m]` (entry arrays) via the replacer before
 * comparing — the same transformation `serializeCsharp` applies. This catches the
 * Map-as-object trap: if the B-side (fresh parse) returns a populated Map and the
 * A-side (cache reload) returns a correctly-rebuilt Map, they must be equal after
 * normalization; if the A-side silently returned an empty Map (broken deserialize),
 * normalization surfaces the empty vs populated diff.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a, mapReplacer) === JSON.stringify(b, mapReplacer);
}

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return [...value];
  return value;
}

/* v8 ignore next 10 -- diffReason is only called on audit failure (diff path) */
function diffReason(a: unknown, b: unknown): string {
  const aStr = JSON.stringify(a, mapReplacer);
  const bStr = JSON.stringify(b, mapReplacer);
  if (aStr === bStr) return '(identical after normalization — Map comparison issue)';
  // Truncate to keep assertion messages readable.
  const maxLen = 300;
  const aSnip = aStr.length > maxLen ? aStr.slice(0, maxLen) + '…' : aStr;
  const bSnip = bStr.length > maxLen ? bStr.slice(0, maxLen) + '…' : bStr;
  return `A: ${aSnip}\nB: ${bSnip}`;
}
