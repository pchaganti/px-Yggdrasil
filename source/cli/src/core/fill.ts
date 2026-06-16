/**
 * source/cli/src/core/fill.ts — the `yg check --approve` fill stage (spec §7).
 *
 * Plain `yg check` is a pure read; `--approve` fills every UNVERIFIED pair, then
 * re-runs the read and reports. Fill is the ONLY place a deterministic check.mjs
 * or an LLM reviewer executes.
 *
 * yg-suppress(deterministic) the fill stage exists to invoke the configured LLM reviewer; non-determinism is inherent to its purpose, and every verdict it records is content-addressed so reproducibility is enforced at the lock layer instead
 *
 * Order (spec §7):
 *   1. Structural gate — validate(graph); a gating code (tier/reviewer config
 *      broken) aborts the whole fill (no fills, no LLM calls).
 *   2. Classify pairs through the SAME engine plain check uses (verifyLock) —
 *      one implementation, so a verdict fill writes here verifies there.
 *      prompt-too-large pairs are SKIPPED (gate precedence, §4).
 *   3. Pre-dispatch header: counts.
 *   4. Per-node log gate (§9): a log_required node whose source fingerprint
 *      drifted with no fresh entry has its pairs skipped (others proceed).
 *   5. Deterministic fills FIRST (free) → deterministic gate (a node with an
 *      enforced det refusal skips its LLM fills this run).
 *   6. LLM fills (grouped by tier; one provider per tier; run-scoped caches).
 *   7. Positive closure (§7.5): a node with all enforced pairs approved records
 *      its source fingerprint + log baseline.
 *   8. GC + canonical rewrite (§3.2).
 *   9. Re-run the read (runCheck) and return its result.
 *
 * Fail-closed (§3.2): an entry is written only on a REAL verdict. Every infra
 * disposition (provider unreachable, no reviewer, tier-resolution failure,
 * reference-load failure, unparseable response, check.mjs runtime error /
 * taint) writes NOTHING — the prior baseline stays intact, the pair stays
 * unverified, and the run ends red.
 *
 * Interruption-safety: the lock is mutated in memory and re-serialized through a
 * single serialized promise chain after EACH completed pair, so a killed run
 * keeps every finished pair and the next run resumes.
 *
 * This module is the orchestrator + public surface. The cohesive stages live in
 * sibling files and are wired in here:
 *   - fill-shared.ts   — shared outcome types + readBytesOrEmpty
 *   - fill-log-gate.ts — the per-node mandatory-log gate (§9)
 *   - fill-det.ts      — the deterministic-pair filler (step 5)
 *   - fill-llm.ts      — the LLM-pair filler (step 6)
 *   - fill-pool.ts     — the bounded worker pool (step 6)
 *   - fill-closure.ts  — positive closure (step 7 / §7.5)
 *   - fill-gc.ts       — GC + canonical rewrite (step 8 / §3.2)
 */

import path from 'node:path';

import type { Graph, AspectDef, LlmConfig } from '../model/graph.js';
import type { VerdictEntry } from '../model/lock.js';
import type { CheckResult } from './check.js';
import { runCheck } from './check.js';
import { readLock, writeLock } from '../io/lock-store.js';
import type { ExpectedPair } from './pairs.js';
import { verifyLock } from './verify-lock.js';
import { selectTierForAspect } from './tier-selection.js';
import { createLlmProvider } from '../llm/index.js';
import { validate } from './validator.js';
import { APPROVE_GATING_CODES } from './check-codes.js';
import type { IssueMessage } from '../model/validation.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import { fillDetPair } from './fill-det.js';
import { fillLlmPair } from './fill-llm.js';
import { runPairPool } from './fill-pool.js';
import { logGateBlocks } from './fill-log-gate.js';
import { applyPositiveClosure } from './fill-closure.js';
import { garbageCollectAndRewrite } from './fill-gc.js';

// ============================================================
// Public surface
// ============================================================

export interface RunFillOptions {
  /** Git-tracked files for the final coverage scan (mirrors plain check). Pass
   *  null to skip the unmapped-files check (no git available). */
  gitTrackedFiles: string[] | null;
  /** Sink for agent-facing fill PROGRESS (plain status lines). Defaults to
   *  process.stdout.write. */
  write?: (s: string) => void;
  /** Sink for structured DIAGNOSTICS ({ what, why, next }). The CLI command
   *  layer supplies the renderer — it owns formatting; this engine module only
   *  emits structured data and never formats it. Defaults to a no-op, so a
   *  caller that wants diagnostics surfaced must provide a sink. */
  emitIssue?: (msg: IssueMessage) => void;
}

export interface RunFillResult {
  /** The final check report after fills (exit semantics: any error ⇒ nonzero). */
  checkResult: CheckResult;
  /** Number of reviewer calls actually dispatched (consensus-inclusive). */
  reviewerCallsMade: number;
  /** Pairs that hit an infra disposition (no write). */
  infraFailures: number;
  /** Deterministic pairs whose check.mjs failed to run / tainted (no write). */
  runtimeErrors: number;
}

/** Abort sentinel — the structural gate failed; no fills ran. */
export class FillGatingError extends Error {
  constructor(public readonly issues: Array<{ code: string; what: string; why: string; next: string }>) {
    super('fill aborted — structural gating errors block tier resolution');
    this.name = 'FillGatingError';
  }
}

// ============================================================
// runFill
// ============================================================

export async function runFill(graph: Graph, opts: RunFillOptions): Promise<RunFillResult> {
  const write = opts.write ?? ((s: string) => { process.stdout.write(s); });
  const emitIssue = opts.emitIssue ?? ((): void => {});
  const projectRoot = path.dirname(graph.rootPath);

  // ── Step 1: Structural gate. A gating code aborts the whole fill. ──────────
  const validation = await validate(graph);
  const gating = validation.issues.filter(
    (i) => i.code !== undefined && APPROVE_GATING_CODES.has(i.code),
  );
  if (gating.length > 0) {
    emitIssue({
      what: 'yg check --approve aborted — configuration errors block tier resolution.',
      why: 'One or more configuration errors must be resolved before any reviewer tier can be selected; the offending errors are listed below.',
      next: 'Fix the errors below, then re-run: yg check --approve',
    });
    for (const i of gating) emitIssue(i.messageData);
    throw new FillGatingError(
      gating.map((i) => ({ code: i.code!, what: i.messageData.what, why: i.messageData.why, next: i.messageData.next })),
    );
  }

  // ── Step 2: Classify pairs through the SAME engine plain check uses. ───────
  // verifyLock recomputes every pair's validity (det re-observation included)
  // and applies the prompt-size gate. Unverified pairs are the fill set;
  // prompt-too-large pairs are skipped (gate precedence). Valid (verified or
  // refused) pairs are already final and never re-run.
  const lock = readLock(graph.rootPath);
  const verification = await verifyLock(graph, lock);

  const unverifiedPairs: ExpectedPair[] = [];
  for (const vp of verification.pairs) {
    if (vp.state.kind === 'unverified') unverifiedPairs.push(vp.pair);
    // verified / refused / prompt-too-large → not filled.
  }

  const detPairs = unverifiedPairs.filter((p) => p.kind === 'deterministic');
  const llmPairs = unverifiedPairs.filter((p) => p.kind === 'llm');

  // Index aspect defs and resolve consensus for the header's call count.
  const aspectById = new Map<string, AspectDef>();
  for (const a of graph.aspects) aspectById.set(a.id, a);

  // ── Step 3: Pre-dispatch header (EXACT). ──────────────────────────────────
  const nodeSet = new Set(unverifiedPairs.map((p) => p.nodePath));
  let reviewerCallBudget = 0;
  for (const p of llmPairs) {
    const aspect = aspectById.get(p.aspectId);
    const reviewer = graph.config.reviewer;
    const tier = aspect && reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
    reviewerCallBudget += tier?.ok ? tier.tier.consensus : 1;
  }
  write(
    `Filling ${unverifiedPairs.length} unverified pairs across ${nodeSet.size} nodes — ` +
      `${detPairs.length} deterministic (no cost), ${reviewerCallBudget} reviewer calls (consensus included)\n`,
  );

  // ── Serialized lock writer (interruption-safe, §7). ───────────────────────
  let writeChain: Promise<void> = Promise.resolve();
  const persistLock = (): Promise<void> => {
    writeChain = writeChain.then(() => writeLock(graph.rootPath, lock));
    return writeChain;
  };
  const setEntry = async (aspectId: string, unitKey: string, entry: VerdictEntry): Promise<void> => {
    (lock.verdicts[aspectId] ??= {})[unitKey] = entry;
    await persistLock();
  };

  // ── Step 4: Log gate per node (§9). A node owning unverified pairs whose
  // log_required type drifted (or first verification) with no fresh entry needs
  // a justification entry first. The gate is all-or-nothing: if ANY node needs an
  // entry, --approve approves NOTHING this run and stops (no fill, no report) —
  // the per-node messages tell the user which entries to add, then re-run.
  const blockedNodes = new Set<string>();
  for (const nodePath of nodeSet) {
    const node = graph.nodes.get(nodePath);
    if (!node) continue;
    const blocked = await logGateBlocks(graph, projectRoot, node, lock, emitIssue);
    if (blocked) blockedNodes.add(nodePath);
  }
  if (blockedNodes.size > 0) {
    throw new FillGatingError([{
      code: 'log-entry-required',
      what: `${blockedNodes.size} node(s) need a fresh log entry before --approve.`,
      why: 'Source changed on log_required nodes without a justification entry; nothing was approved this run.',
      next: 'Add the log entries listed above (yg log add), then re-run: yg check --approve',
    }]);
  }

  let reviewerCallsMade = 0;
  let infraFailures = 0;
  let runtimeErrors = 0;

  // ── Step 5: Deterministic fills FIRST (free). ─────────────────────────────
  // A node with an enforced det refusal (fresh OR cached-valid) skips its LLM
  // fills this run. Track which nodes carry such a refusal across BOTH sources.
  const detEnforcedRefusedNodes = new Set<string>();

  // Seed from CACHED-valid enforced det refusals (verifyLock already classified
  // the lock; a valid refused det pair on an enforced status blocks LLM fills).
  for (const vp of verification.pairs) {
    if (vp.pair.kind !== 'deterministic') continue;
    if (vp.state.kind === 'refused' && vp.pair.status === 'enforced') {
      detEnforcedRefusedNodes.add(vp.pair.nodePath);
    }
  }

  for (const pair of detPairs) {
    if (blockedNodes.has(pair.nodePath)) continue;
    const aspect = aspectById.get(pair.aspectId);
    if (!aspect) continue;
    const outcome = await fillDetPair(graph, projectRoot, pair, aspect, emitIssue);
    if (outcome.kind === 'runtime-error') {
      runtimeErrors += 1;
      // No write — pair stays unverified, reported as aspect-check-runtime-error.
      continue;
    }
    // Real verdict — write the entry.
    await setEntry(pair.aspectId, pair.unitKey, outcome.entry);
    write(`  [det] ${pair.aspectId} on ${toPosixPath(pair.unitKey)} — ${outcome.entry.verdict}\n`);
    if (outcome.entry.verdict === 'refused' && pair.status === 'enforced') {
      detEnforcedRefusedNodes.add(pair.nodePath);
    }
  }

  // ── Deterministic gate: report nodes whose LLM fills are skipped. ──────────
  const llmSkippedByDetGate = new Set<string>();
  for (const pair of llmPairs) {
    if (detEnforcedRefusedNodes.has(pair.nodePath)) {
      llmSkippedByDetGate.add(pair.nodePath);
    }
  }
  for (const nodePath of llmSkippedByDetGate) {
    emitIssue({
      what: `LLM fills for node '${toPosixPath(nodePath)}' skipped — an enforced deterministic check already refused it.`,
      why: 'A free deterministic check rejects this node, so paying the reviewer to read the same code would be wasted. Fix the deterministic violations first.',
      next: `Fix the deterministic violations on '${toPosixPath(nodePath)}', then re-run: yg check --approve`,
    });
  }

  // ── Step 6: LLM fills — grouped by resolved tier; one provider per tier. ───
  // Tier config already reflects the yg-secrets overlay (deep-merged at config
  // parse time), so no per-provider secret merge happens here.
  // Reference bytes are cached as RAW disk Buffers (null = missing/unreadable) so
  // the producer hashes and prompts the SAME bytes the verifier re-reads through
  // readFileBytes — a BOM or non-UTF-8 reference can never desync the two sides
  // (spec §3.1; Bug 1).
  const referencesCache = new Map<string, Buffer | null>();

  // Resolve each fillable LLM pair to its tier; an unresolvable tier is an infra
  // disposition (no write). Group resolvable pairs by tier name.
  interface ResolvedLlmPair { pair: ExpectedPair; aspect: AspectDef; tier: LlmConfig; tierName: string }
  const byTier = new Map<string, ResolvedLlmPair[]>();
  const infraReport: Array<{ provider?: string; tier?: string }> = [];

  for (const pair of llmPairs) {
    if (blockedNodes.has(pair.nodePath) || llmSkippedByDetGate.has(pair.nodePath)) continue;
    const aspect = aspectById.get(pair.aspectId);
    if (!aspect) continue;
    const reviewer = graph.config.reviewer;
    const tierResult = reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
    if (!tierResult || !tierResult.ok) {
      // No reviewer configured OR tier resolution failed — infra disposition.
      infraFailures += 1;
      infraReport.push({ tier: aspect.reviewer.tier });
      emitIssue({
        what: `Cannot resolve a reviewer tier for aspect '${pair.aspectId}' on ${toPosixPath(pair.unitKey)} — left unverified.`,
        why: tierResult && !tierResult.ok ? tierResult.error.why : 'No reviewer is configured for an effective non-draft LLM aspect.',
        next: tierResult && !tierResult.ok ? tierResult.error.next : 'Add a reviewer tier in .yggdrasil/yg-config.yaml, or set the aspect to status: draft.',
      });
      continue;
    }
    const list = byTier.get(tierResult.tierName) ?? [];
    list.push({ pair, aspect, tier: tierResult.tier, tierName: tierResult.tierName });
    byTier.set(tierResult.tierName, list);
  }

  const parallel = Math.max(1, graph.config.parallel ?? 1);

  for (const [tierName, group] of byTier) {
    // Tier config already includes the yg-secrets overlay (applied at parse time).
    const baseTier = group[0].tier;
    const provider = createLlmProvider(baseTier);

    // Availability is an infra gate — if the provider is unreachable, every
    // pair in this tier is an infra disposition (no write).
    let available: boolean;
    try {
      available = await provider.isAvailable();
    } catch (e) {
      debugWrite(`[fill] provider.isAvailable threw for tier ${tierName}: ${e instanceof Error ? e.message : String(e)}`);
      available = false;
    }
    if (!available) {
      infraFailures += group.length;
      infraReport.push({ provider: baseTier.provider, tier: tierName });
      emitIssue({
        what: `Reviewer provider '${baseTier.provider}' (tier '${tierName}') is unreachable — ${group.length} pair(s) left unverified.`,
        why: 'The configured reviewer endpoint did not respond (availability check failed) — an infrastructure problem, not a code violation. No verdict was written.',
        next: `Check the provider endpoint, network, and credentials, then re-run: yg check --approve`,
      });
      continue;
    }

    // Worker pool bounded by parallel; consensus runs sequentially in-slot.
    const outcomes = await runPairPool(group, parallel, async (item) => {
      const outcome = await fillLlmPair(graph, projectRoot, item.pair, item.aspect, item.tier, item.tierName, baseTier, provider, referencesCache);
      // Persist each verdict the moment its pair completes — like the deterministic
      // loop — so interrupting the run (Ctrl+C) keeps every finished verdict and the
      // next run resumes only the rest (§7). Infra dispositions write nothing.
      // setEntry's mutation is synchronous and persistLock serializes the disk
      // writes, so concurrent pool workers cannot corrupt the lock.
      if (outcome.kind !== 'infra') {
        await setEntry(item.pair.aspectId, item.pair.unitKey, outcome.entry);
        write(`  [llm] ${item.pair.aspectId} on ${toPosixPath(item.pair.unitKey)} — ${outcome.entry.verdict}\n`);
      }
      return outcome;
    });

    // Tally counters and surface infra dispositions (no persistence here — the
    // verdicts were already written inside the pool as each pair finished).
    for (let i = 0; i < group.length; i++) {
      const item = group[i];
      const outcome = outcomes[i];
      reviewerCallsMade += outcome.callsMade;
      if (outcome.kind === 'infra') {
        infraFailures += 1;
        infraReport.push({ provider: baseTier.provider, tier: tierName });
        emitIssue({
          what: `Reviewer could not verify aspect '${item.pair.aspectId}' on ${toPosixPath(item.pair.unitKey)} — left unverified.`,
          why: outcome.why,
          next: `Resolve the provider/config problem, then re-run: yg check --approve`,
        });
      }
    }
  }

  // ── Step 7: Positive closure (§7.5). ──────────────────────────────────────
  // Re-classify against the POST-FILL lock so closure sees the verdicts just
  // written. A node with a missing/stale fingerprint closes (records source +
  // log baseline) only when ALL its enforced effective pairs are approved.
  // Deliberate post-fill re-classification: must see freshly-written verdicts —
  // do not thread step-2 (pre-fill verifyLock) results through. blockedNodes
  // (the step-4 log-gate set) is threaded so a node whose pairs were skipped this
  // run can never close over its stale verdicts.
  await applyPositiveClosure(graph, projectRoot, lock, blockedNodes, persistLock);

  // ── Step 8: GC + canonical rewrite (§3.2). ────────────────────────────────
  // Deliberate post-fill re-classification: must see freshly-written verdicts —
  // do not thread step-2 (pre-fill verifyLock) results through.
  await garbageCollectAndRewrite(graph, lock, persistLock);

  // ── Step 9: Summaries + re-run the read. ──────────────────────────────────
  if (reviewerCallsMade === 0 && infraFailures === 0 && runtimeErrors === 0) {
    write('0 reviewer calls made — all expected pairs hold valid verdicts\n');
  }
  if (infraFailures > 0) {
    const providers = [...new Set(infraReport.map((r) => r.provider).filter(Boolean))].join(', ');
    const tiers = [...new Set(infraReport.map((r) => r.tier).filter(Boolean))].join(', ');
    const ids = [providers, tiers].filter((s) => s.length > 0).join(' / ');
    emitIssue({
      what: `${infraFailures} pairs failed on provider/config errors — re-running will not help until the connection/config is fixed${ids ? ` (${ids})` : ''}.`,
      why: 'These pairs hit an infrastructure disposition (provider unreachable, tier unresolved, reference unreadable, or an unparseable response). No verdict was written; the pairs stay unverified and the run ends red.',
      next: 'Fix the reviewer connection/configuration, then re-run: yg check --approve. To unblock CI without a reviewer, set the affected aspect(s) to status: draft.',
    });
  }
  if (runtimeErrors > 0) {
    emitIssue({
      what: `${runtimeErrors} deterministic check(s) failed to run at fill time — left unverified (aspect-check-runtime-error).`,
      why: 'A check.mjs crashed, returned an invalid result, or observed a file that changed mid-run. No verdict was written.',
      next: 'Fix the failing check.mjs, then re-run: yg check --approve.',
    });
  }

  // Make sure all queued writes have flushed before the final read.
  await writeChain;

  const checkResult = await runCheck(graph, opts.gitTrackedFiles);
  return { checkResult, reviewerCallsMade, infraFailures, runtimeErrors };
}
