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
 */

import path from 'node:path';

import type { Graph, GraphNode, AspectDef, LlmConfig } from '../model/graph.js';
import type { LockFile, VerdictEntry, Verdict } from '../model/lock.js';
import { LOCK_FORMAT_VERSION, nodeUnit } from '../model/lock.js';
import { runRelationPass } from '../relations/pass.js';
import { extractorForLanguage } from '../relations/extractors/registry.js';
import { relationIndexDir } from '../relations/index-dir.js';
import type { CheckResult } from './check.js';
import { runCheck } from './check.js';
import { readLock, writeLock } from '../io/lock-store.js';
import {
  computeExpectedPairs,
  computeSourceFingerprint,
  computeNodeMappedFiles,
  computeUncomputableNodes,
  FileUnreadableError,
} from './pairs.js';
import type { ExpectedPair } from './pairs.js';
import { verifyLock } from './verify-lock.js';
import { computeLlmInputHash, computeDetInputHash } from './pair-hash.js';
import { ruleHashFor, contentFor, nodeDescriptionFor, tierHashViewFromTier } from './pair-inputs.js';
import { hashBytes } from '../io/hash.js';
import { selectTierForAspect } from './tier-selection.js';
import { buildPairPrompt } from '../llm/prompt.js';
import type { PromptReferenceInput, PromptFileInput } from '../llm/prompt.js';
import { verifyWithConsensus } from '../llm/aspect-verifier.js';
import { createLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { loadSecrets, mergeLlmConfig } from '../io/secrets-parser.js';
import { runStructureAspect, StructureRunnerError } from '../structure/runner.js';
import { validate } from './validator.js';
import { APPROVE_GATING_CODES } from './check-codes.js';
import { readFileBytes } from '../io/graph-fs.js';
import {
  hasFreshLogEntry,
  computeLogBaselineForNode,
  readLogContent,
} from './log/log-gate.js';
import type { IssueMessage } from '../model/validation.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath, toPosix } from '../utils/posix.js';
import { isPathInMapping } from '../structure/expand-mapping-sync.js';

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

  // ── Relation-conformance pass (sequential, full graph, before the pool). ──
  // Runs once over the whole graph BEFORE the parallel pair pool — never as a
  // parallel pair — so its single shared symbol-index build and the serialized
  // lock writer never race the pool's per-pair writes. Phase 0: the extractor
  // registry is empty, so no dependencies are detected and every mapped node
  // gets an `approved` verdict.
  const relResult = await runRelationPass(graph, projectRoot, {
    extractorFor: extractorForLanguage,
    resolvePathToFile: () => undefined, // Phase 0: no extractors registered → no path hints → never called. Phase 1 injects the real per-language resolver.
    symbolIndexDir: relationIndexDir(graph.rootPath),
  });
  for (const [nodeId, v] of relResult.verdicts) {
    lock.relation_verdicts[nodeUnit(nodeId)] = {
      verdict: v.verdict,
      fingerprint: v.fingerprint,
      reason: v.reason,
      evidence: v.evidence,
    };
  }
  await persistLock();

  // ── Step 4: Log gate per node (§9). Nodes owning unverified pairs whose ────
  // log_required type drifted (or first verification) with no fresh entry are
  // BLOCKED: their pairs are skipped; other nodes proceed.
  const blockedNodes = new Set<string>();
  for (const nodePath of nodeSet) {
    const node = graph.nodes.get(nodePath);
    if (!node) continue;
    const blocked = await logGateBlocks(graph, projectRoot, node, lock, emitIssue);
    if (blocked) blockedNodes.add(nodePath);
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
  const secretsByProvider = new Map<string, Partial<LlmConfig> | null>();
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
    // One provider per tier per run. Merge run-scoped secrets once.
    const baseTier = group[0].tier;
    if (!secretsByProvider.has(baseTier.provider)) {
      const secrets = await loadSecrets(graph.rootPath, baseTier.provider);
      secretsByProvider.set(baseTier.provider, secrets ?? null);
    }
    const merged = applySecrets(baseTier, secretsByProvider.get(baseTier.provider));
    const provider = createLlmProvider(merged);

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
      infraReport.push({ provider: merged.provider, tier: tierName });
      emitIssue({
        what: `Reviewer provider '${merged.provider}' (tier '${tierName}') is unreachable — ${group.length} pair(s) left unverified.`,
        why: 'The configured reviewer endpoint did not respond (availability check failed) — an infrastructure problem, not a code violation. No verdict was written.',
        next: `Check the provider endpoint, network, and credentials, then re-run: yg check --approve`,
      });
      continue;
    }

    // Worker pool bounded by parallel; consensus runs sequentially in-slot.
    const outcomes = await runPairPool(group, parallel, async (item) => {
      return fillLlmPair(graph, projectRoot, item.pair, item.aspect, item.tier, item.tierName, merged, provider, referencesCache);
    });

    for (let i = 0; i < group.length; i++) {
      const item = group[i];
      const outcome = outcomes[i];
      reviewerCallsMade += outcome.callsMade;
      if (outcome.kind === 'infra') {
        infraFailures += 1;
        infraReport.push({ provider: merged.provider, tier: tierName });
        emitIssue({
          what: `Reviewer could not verify aspect '${item.pair.aspectId}' on ${toPosixPath(item.pair.unitKey)} — left unverified.`,
          why: outcome.why,
          next: `Resolve the provider/config problem, then re-run: yg check --approve`,
        });
        continue;
      }
      await setEntry(item.pair.aspectId, item.pair.unitKey, outcome.entry);
      write(`  [llm] ${item.pair.aspectId} on ${toPosixPath(item.pair.unitKey)} — ${outcome.entry.verdict}\n`);
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

// ============================================================
// Log gate (§9)
// ============================================================

/**
 * True when a node is blocked by the mandatory-log gate (spec §9): the type opts
 * into log_required (default false) AND the current source fingerprint differs
 * from the stored one (or none is stored and the mapping is non-empty — first
 * verification) AND no fresh log entry exists.
 *
 * This is the SINGLE source of truth for the freshness/fingerprint rule. The
 * fill step-4 gate (logGateBlocks) and positive closure both consult it, so a
 * node closure can never advance a fingerprint the gate would have blocked
 * (defects 1, 2, 4: a node that never entered the run's nodeSet — e.g. its
 * source change touched only scope/binary-excluded files, leaving zero
 * unverified pairs — was never passed through step 4, so closure must re-check
 * the gate itself rather than trust step-4's blocked set alone).
 */
async function logGateBlocksNode(
  graph: Graph,
  projectRoot: string,
  node: GraphNode,
  lock: LockFile,
): Promise<boolean> {
  // The default lives HERE and only here (spec §9): false unless the type opts in.
  const archType = graph.architecture.node_types[node.meta.type];
  const logRequired = archType?.log_required ?? false;
  if (!logRequired) return false;

  let currentFingerprint: string | undefined;
  try {
    currentFingerprint = await computeSourceFingerprint(graph, node.path);
  } catch (e) {
    // An unreadable mapped file makes the fingerprint uncomputable. The node is
    // already surfaced as a blocking file-unreadable error; block it here too so
    // its pairs are never filled/closed over an unreadable source.
    if (e instanceof FileUnreadableError) {
      debugWrite(`[fill] logGate fingerprint for ${node.path}: ${e.message}`);
      return true;
    }
    throw e;
  }
  // A mapping-less node has a constant (undefined) fingerprint — the gate never
  // fires for it (§9). A node with a non-empty mapping but no stored fingerprint
  // is a first verification (drifted = true).
  if (currentFingerprint === undefined) return false;
  const storedFingerprint = lock.nodes[node.path]?.source;
  const drifted = currentFingerprint !== storedFingerprint;
  if (!drifted) return false;

  const logContent = await readLogContent(projectRoot, node.path);
  return !hasFreshLogEntry(logContent, lock.nodes[node.path]?.log);
}

/**
 * Step-4 log gate: like logGateBlocksNode, but emits the `log-entry-missing`
 * message when it blocks (its pairs are skipped this run; other nodes proceed).
 */
async function logGateBlocks(
  graph: Graph,
  projectRoot: string,
  node: GraphNode,
  lock: LockFile,
  emitIssue: (msg: IssueMessage) => void,
): Promise<boolean> {
  const blocked = await logGateBlocksNode(graph, projectRoot, node, lock);
  if (!blocked) return false;

  emitIssue({
    what: `No fresh log entry for node '${toPosixPath(node.path)}' — mandatory before --approve when source changed.`,
    why: `Node type '${node.meta.type}' has log_required: true — every source change needs a justification entry capturing WHY. This node's pairs are skipped this run; other nodes proceed.`,
    next: `yg log add --node ${toPosixPath(node.path)} --reason '<justification>', then re-run: yg check --approve`,
  });
  return true;
}

// ============================================================
// Deterministic fill
// ============================================================

type DetFillOutcome =
  | { kind: 'verdict'; entry: VerdictEntry }
  | { kind: 'runtime-error' };

/**
 * Fill one deterministic pair. Runs check.mjs through the structure runner with a
 * subjectScope WHENEVER the pair's subject set is NARROWER than the node's full
 * mapping (spec §1, §3.1; contract #8):
 *
 *   - `per: file` → subject is a single file (always narrower unless the node
 *     maps exactly that one file).
 *   - `per: node` + `scope.files` that actually excludes a mapped file → the
 *     excluded siblings are NOT subjects; without subjectScope the runner would
 *     preload them into ctx.node.files UN-recorded, so a check reading an excluded
 *     file folds into NEITHER the subject hash NOR an observation → stale-green.
 *     subjectScope makes those reads record as `read:` observations, which the
 *     verifier re-observes (a later edit to an excluded-but-read file invalidates
 *     the pair).
 *
 * A plain `per: node` aspect with no filter (or a scope.files that matches every
 * mapped file) keeps the legacy path (subjectScope undefined) so the documented
 * `ctx.files === ctx.node.files` alias is preserved.
 *
 * MANDATORY A6 carry-overs:
 *   (1) gate on succeeded === true BEFORE consuming observations (a failed run's
 *       observations are meaningless).
 *   (2) a tainted result must NEVER be written — re-run once; still tainted →
 *       runtime-error (no write).
 */
async function fillDetPair(
  graph: Graph,
  projectRoot: string,
  pair: ExpectedPair,
  aspect: AspectDef,
  emitIssue: (msg: IssueMessage) => void,
): Promise<DetFillOutcome> {
  const aspectDirAbs = path.join(projectRoot, '.yggdrasil', 'aspects', aspect.id);
  // The subject is narrowed iff it covers FEWER files than the node's full
  // mapping (pair.subjectFiles ⊆ full mapping always, so a length difference is
  // an exact set difference). Both per:file and per:node-with-scope.files can
  // narrow; a plain per:node aspect has subject == full mapping → undefined.
  const fullMapping = await computeNodeMappedFiles(graph, pair.nodePath);
  const subjectScope = pair.subjectFiles.length < fullMapping.length
    ? pair.subjectFiles
    : undefined;

  const runOnce = async () => {
    try {
      return { ok: true as const, result: await runStructureAspect({
        aspectDir: aspectDirAbs,
        aspectId: aspect.id,
        nodePath: pair.nodePath,
        graph,
        projectRoot,
        subjectScope,
      }) };
    } catch (e) {
      debugWrite(`[fill] det runtime error for ${aspect.id} on ${pair.nodePath}: ${e instanceof Error ? e.message : String(e)}`);
      const rendered = e instanceof StructureRunnerError
        ? `${e.messageData.what} — ${e.messageData.why}`
        : (e instanceof Error ? e.message : String(e));
      return { ok: false as const, rendered };
    }
  };

  let run = await runOnce();
  // A6 carry-over (1): a result with succeeded === false is an infra disposition.
  if (!run.ok) {
    emitIssue(detRuntimeNotice(aspect.id, pair.unitKey, run.rendered));
    return { kind: 'runtime-error' };
  }
  if (run.result.succeeded === false) {
    const reason = run.result.violations.map((v) => v.message).join('\n') || 'check runtime error';
    emitIssue(detRuntimeNotice(aspect.id, pair.unitKey, reason));
    return { kind: 'runtime-error' };
  }
  // A6 carry-over (2): a tainted observation set must never be cached — a file
  // changed mid-run. Re-run once; if it taints again, fail closed (no write).
  if (run.result.observationsTainted) {
    run = await runOnce();
    if (!run.ok) {
      emitIssue(detRuntimeNotice(aspect.id, pair.unitKey, run.rendered));
      return { kind: 'runtime-error' };
    }
    if (run.result.succeeded === false || run.result.observationsTainted) {
      emitIssue(detRuntimeNotice(aspect.id, pair.unitKey, 'observations remained inconsistent across two runs (a file changed mid-check)'));
      return { kind: 'runtime-error' };
    }
  }

  const violations = run.result.violations;
  const verdict: Verdict = violations.length > 0 ? 'refused' : 'approved';
  const observations = run.result.observations;

  // Subject file hashes from current disk (sorted by path) — mirrors verifyDetPair.
  const files: Array<[string, string]> = [];
  for (const rel of pair.subjectFiles) {
    const abs = path.resolve(projectRoot, rel);
    const bytes = await readBytesOrEmpty(abs);
    files.push([rel, hashBytes(bytes)]);
  }

  const hash = computeDetInputHash({
    aspectId: aspect.id,
    scope: aspect.scope,
    nodePath: pair.nodePath,
    ruleHash: ruleHashFor(aspect, 'check.mjs'),
    files,
    touched: observations,
    verdict,
  });

  const entry: VerdictEntry = { verdict, hash, touched: observations };
  if (verdict === 'refused') {
    entry.reason = violations
      .map((v) => {
        const file = v.file ? toPosixPath(v.file) : v.file;
        const loc = file ? `${file}:${v.line ?? '?'}: ` : '';
        return `${loc}${v.message}`;
      })
      .join('\n');
  }
  return { kind: 'verdict', entry };
}

function detRuntimeNotice(aspectId: string, unitKey: string, reason: string): IssueMessage {
  return {
    what: `Deterministic check '${aspectId}' failed to run on ${toPosixPath(unitKey)} — left unverified (aspect-check-runtime-error).`,
    why: `The check.mjs crashed, returned an invalid result, or its observations changed mid-run: ${reason}`,
    next: `Fix the check.mjs, then re-run: yg check --approve`,
  };
}

// ============================================================
// LLM fill
// ============================================================

type LlmFillOutcome =
  | { kind: 'verdict'; entry: VerdictEntry; callsMade: number }
  | { kind: 'infra'; why: string; callsMade: number };

/**
 * Fill one LLM pair: load references (a MISSING reference is a LOUD infra
 * failure — contract #6, never empty-bytes hashing), assemble the prompt, run
 * the tier's consensus votes, and on a real verdict compute the hash + entry.
 * Every infra disposition (reference unreadable, provider error/unparseable)
 * returns { kind: 'infra' } so the caller writes NOTHING.
 */
async function fillLlmPair(
  graph: Graph,
  projectRoot: string,
  pair: ExpectedPair,
  aspect: AspectDef,
  tier: LlmConfig,
  tierName: string,
  mergedTier: LlmConfig,
  provider: LlmProvider,
  referencesCache: Map<string, Buffer | null>,
): Promise<LlmFillOutcome> {
  // ── Load subject file bytes (sorted by path is the pair's contract). ──
  const subjects: Array<{ path: string; bytes: Buffer }> = [];
  for (const rel of pair.subjectFiles) {
    const bytes = await readBytesOrEmpty(path.resolve(projectRoot, rel));
    subjects.push({ path: rel, bytes });
  }

  // ── Load references as RAW disk bytes — byte-identical to the verifier
  // (verify-lock.ts reads each reference via readFileBytes and folds those raw
  // bytes; the prompt content there is rawBytes.toString('utf8')). Hashing,
  // prompting, and the §4 size gate must all be measured over the SAME bytes, so
  // a reference carrying a UTF-8 BOM or an invalid byte cannot make the producer
  // and verifier disagree (which would pin the verdict to a permanent false-red).
  // A missing reference stays a LOUD infra failure (#6) — never hashed over
  // empty-substituted bytes. ──
  const refInputs = aspect.references ?? [];
  const referencesForHash: Array<[string, string, string]> = [];
  const referencesForPrompt: PromptReferenceInput[] = [];
  for (const ref of refInputs) {
    const absRef = path.resolve(projectRoot, ref.path);
    let bytes = referencesCache.get(absRef);
    if (bytes === undefined) {
      bytes = await readFileBytes(absRef); // raw disk Buffer, no decode, no BOM strip; null on error
      if (bytes === null) {
        debugWrite(`[fill] reference load failed for ${aspect.id} path ${ref.path}`);
      }
      referencesCache.set(absRef, bytes);
    }
    if (bytes === null) {
      // Never hash over empty-substituted bytes — fail closed.
      return { kind: 'infra', why: `reference '${toPosixPath(ref.path)}' for aspect '${aspect.id}' could not be read`, callsMade: 0 };
    }
    referencesForHash.push([ref.path, hashBytes(bytes), ref.description ?? '']);
    referencesForPrompt.push({ path: ref.path, description: ref.description, content: bytes.toString('utf8') });
  }

  const prompt = buildPairPrompt({
    aspect: { id: aspect.id, description: aspect.description ?? '', content: contentFor(aspect, 'content.md') },
    references: referencesForPrompt,
    nodePath: pair.nodePath,
    nodeDescription: nodeDescriptionFor(graph, pair.nodePath),
    files: subjects.map<PromptFileInput>((s) => ({ path: s.path, content: s.bytes.toString('utf8') })),
    scope: aspect.scope,
  });

  const consensus = mergedTier.consensus;
  let response;
  try {
    response = await verifyWithConsensus(provider, prompt, consensus);
  } catch (e) {
    debugWrite(`[fill] reviewer threw for ${aspect.id} on ${pair.unitKey}: ${e instanceof Error ? e.message : String(e)}`);
    return { kind: 'infra', why: `the reviewer threw or returned an unparseable response: ${e instanceof Error ? e.message : String(e)}`, callsMade: consensus };
  }

  // A provider-sourced failure is infra (no write). Only a codeViolation maps to
  // a real verdict token.
  if (!response.satisfied && response.errorSource === 'provider') {
    return { kind: 'infra', why: `the reviewer returned a provider error: ${response.reason}`, callsMade: consensus };
  }

  const verdict: Verdict = response.satisfied ? 'approved' : 'refused';
  const hash = computeLlmInputHash({
    aspectId: aspect.id,
    aspectDescription: aspect.description ?? '',
    scope: aspect.scope,
    nodePath: pair.nodePath,
    ruleHash: ruleHashFor(aspect, 'content.md'),
    files: subjects.map((s) => [s.path, hashBytes(s.bytes)] as [string, string]),
    references: referencesForHash,
    tier: tierHashViewFromTier(tierName, tier),
    verdict,
  });

  const entry: VerdictEntry = { verdict, hash };
  if (verdict === 'refused') entry.reason = response.reason;
  return { kind: 'verdict', entry, callsMade: consensus };
}

// ============================================================
// Positive closure (§7.5)
// ============================================================

/**
 * Positive closure (spec §7 step 5 / §9). For every node with a missing/stale
 * source fingerprint, advance its fingerprint + log baseline IFF, AT THE END OF
 * THIS RUN, ALL of the following hold:
 *
 *   (a) the node was NOT log-gate-blocked this run (blockedNodes), AND
 *   (b) the node is not blocked by the mandatory-log gate when re-checked here —
 *       this catches a drifted log_required node that never entered the run's
 *       nodeSet (its source change touched only scope/binary-excluded files, so
 *       it produced zero unverified pairs and step 4 never saw it), AND a drifted
 *       log_required node with ZERO enforced pairs (which must NOT vacuously
 *       close without a fresh entry), AND
 *   (c) every ENFORCED effective pair of the node is approved AGAINST CURRENT
 *       INPUTS — i.e. its post-fill verifyLock state is `verified` (a valid entry
 *       carrying an approved token). A pair that is merely stored-`approved` but
 *       is currently `unverified` (inputs changed, not re-verified this run),
 *       `refused`, or `prompt-too-large` does NOT count.
 *
 * INVARIANT: the closure decision NEVER reads lock.verdicts[...].verdict
 * directly. Fresh validity is sourced from a single post-fill verifyLock pass —
 * the authoritative per-pair classification for THIS run — so a stale-but-stored
 * approved token can never advance a fingerprint over code the run did not
 * actually verify (false-green of both the verdict and the §9 log gate).
 *
 * Advisory refusals never block closure (they are not enforced pairs). A node
 * with no enforced pairs at all closes vacuously ONLY when (a)+(b) also hold —
 * for a drifted log_required node that means a fresh log entry is required.
 * Mapping-less nodes have no source fingerprint; their log baseline is still
 * recorded at closure if a log.md exists (spec §9).
 */
async function applyPositiveClosure(
  graph: Graph,
  projectRoot: string,
  lock: LockFile,
  blockedNodes: Set<string>,
  persistLock: () => Promise<void>,
): Promise<void> {
  // Single post-fill verification pass: the authoritative per-pair validity for
  // THIS run, computed against the freshly-written lock. This is the ONLY source
  // of truth for closure — never the raw stored verdict token.
  const verification = await verifyLock(graph, lock);
  const byNode = new Map<string, typeof verification.pairs>();
  for (const vp of verification.pairs) {
    const list = byNode.get(vp.pair.nodePath) ?? [];
    list.push(vp);
    byNode.set(vp.pair.nodePath, list);
  }

  let mutated = false;
  for (const [nodePath, node] of graph.nodes) {
    let currentFingerprint: string | undefined;
    try {
      currentFingerprint = await computeSourceFingerprint(graph, nodePath);
    } catch (e) {
      // An unreadable mapped file makes the fingerprint uncomputable. The node is
      // a blocking file-unreadable error this run — never close over it (advancing
      // the fingerprint/log baseline here would be a stale-green of the §9 gate).
      if (e instanceof FileUnreadableError) {
        debugWrite(`[fill] closure fingerprint for ${nodePath}: ${e.message}`);
        continue;
      }
      throw e;
    }
    if (currentFingerprint === undefined) {
      // Mapping-less node: no source fingerprint to record. Its log baseline is
      // still recorded at closure if a log.md exists (spec §9).
      await closeLogBaselineOnly(projectRoot, nodePath, lock);
      mutated = true;
      continue;
    }
    const stored = lock.nodes[nodePath]?.source;
    if (currentFingerprint === stored) continue; // fingerprint current — nothing to close

    // (a) A node whose pairs were skipped by the step-4 log gate this run must
    // never close over its stale verdicts.
    if (blockedNodes.has(nodePath)) continue;

    // (b) Re-check the mandatory-log gate here. This independently blocks a
    // drifted log_required node that step 4 never saw (zero unverified pairs) and
    // a drifted log_required node with zero enforced pairs (no vacuous close).
    if (await logGateBlocksNode(graph, projectRoot, node, lock)) continue;

    // (c) Every ENFORCED effective pair must be FRESHLY verified-approved this
    // run (state.kind === 'verified'); stored-approved-but-unverified does NOT
    // count. Advisory refusals are not enforced pairs and never block closure.
    const nodePairs = byNode.get(nodePath) ?? [];
    const allEnforcedApproved = nodePairs
      .filter((vp) => vp.pair.status === 'enforced')
      .every((vp) => vp.state.kind === 'verified');
    if (!allEnforcedApproved) continue; // a red/unverified enforced pair keeps the cycle open

    const entry = lock.nodes[nodePath] ?? {};
    entry.source = currentFingerprint;
    const logBaseline = await computeLogBaselineForNode(projectRoot, nodePath);
    if (logBaseline) entry.log = logBaseline;
    lock.nodes[nodePath] = entry;
    mutated = true;
  }
  if (mutated) await persistLock();
}

/** Record only the log baseline for a mapping-less node (spec §9). */
async function closeLogBaselineOnly(projectRoot: string, nodePath: string, lock: LockFile): Promise<void> {
  const logBaseline = await computeLogBaselineForNode(projectRoot, nodePath);
  if (!logBaseline) return;
  const entry = lock.nodes[nodePath] ?? {};
  entry.log = logBaseline;
  lock.nodes[nodePath] = entry;
}

// ============================================================
// GC + canonical rewrite (§3.2)
// ============================================================

/**
 * Owning node path for a repo-relative POSIX file, resolved from the graph's node
 * mappings (longest-mapping wins). Returns null when no node maps the file. Used
 * only to attribute a `file:` verdict entry to a node during GC's
 * positively-detached proof — never for read scoping.
 */
function ownerNodeForFile(graph: Graph, file: string): string | null {
  let best: { nodePath: string; len: number } | null = null;
  for (const [nodePath, node] of graph.nodes) {
    for (const m of (node.meta.mapping ?? []).map(toPosix)) {
      if (isPathInMapping(file, [m]) && (!best || m.length > best.len)) {
        best = { nodePath, len: m.length };
      }
    }
  }
  return best ? best.nodePath : null;
}

/**
 * The owning node path for a verdict entry's unit key. `node:<path>` resolves
 * directly; `file:<path>` resolves through the node mappings. Returns null only
 * for a `file:` key whose file maps to no node (genuinely detached).
 */
function owningNodeForUnitKey(graph: Graph, unitKey: string): string | null {
  if (unitKey.startsWith('node:')) return unitKey.slice('node:'.length);
  if (unitKey.startsWith('file:')) return ownerNodeForFile(graph, toPosix(unitKey.slice('file:'.length)));
  /* v8 ignore next -- unit keys are always node:/file: by construction */
  return null;
}

/**
 * Prune verdict entries whose pair is no longer in the expected universe
 * (includeDraft: true — draft pairs keep their entries) and `nodes` entries for
 * node paths absent from the graph, then rewrite canonically.
 *
 * GC may only prune entries it can POSITIVELY prove are detached. A node whose
 * effective-aspect computation THROWS (an implies cycle, etc.) is silently
 * skipped by computeExpectedPairs, so it contributes NO pairs to the universe —
 * its entries would look detached even though they are valid paid verdicts.
 * Such a node's entries are RETAINED untouched (the validator still surfaces the
 * cycle as a blocking error). The universe accounts only for nodes that COULD be
 * computed, so an entry is pruned iff (pair ∉ universe) AND (its owning node was
 * NOT uncomputable this run) — a node that vanished from the graph is not
 * uncomputable (it is not iterated), so its entries remain prunable.
 */
async function garbageCollectAndRewrite(
  graph: Graph,
  lock: LockFile,
  persistLock: () => Promise<void>,
): Promise<void> {
  const { pairs } = await computeExpectedPairs(graph, { includeDraft: true });
  const universe = new Set<string>(); // `${aspectId}\0${unitKey}`
  for (const p of pairs) universe.add(`${p.aspectId}\0${p.unitKey}`);

  // Nodes whose effectiveness threw this run — their pairs never reach the
  // universe, so their entries must NOT be treated as detached.
  const uncomputable = computeUncomputableNodes(graph);

  // Prune verdicts ∉ universe, EXCEPT entries owned by an uncomputable node.
  for (const aspectId of Object.keys(lock.verdicts)) {
    const unitMap = lock.verdicts[aspectId];
    for (const unitKey of Object.keys(unitMap)) {
      if (universe.has(`${aspectId}\0${unitKey}`)) continue;
      const owner = owningNodeForUnitKey(graph, unitKey);
      // Retain only when we can attribute the entry to a node that could not be
      // computed this run. Everything else (deleted node, detached aspect,
      // deleted/unmapped file) is positively detached → prune.
      if (owner !== null && uncomputable.has(owner)) continue;
      delete unitMap[unitKey];
    }
    if (Object.keys(unitMap).length === 0) delete lock.verdicts[aspectId];
  }

  // Prune nodes for absent node paths.
  for (const nodePath of Object.keys(lock.nodes)) {
    if (!graph.nodes.has(nodePath)) delete lock.nodes[nodePath];
  }

  // Prune relation verdicts for unit keys whose node no longer exists (a relation
  // verdict is always node-keyed; a non-`node:` key or an absent node is detached).
  for (const unitKey of Object.keys(lock.relation_verdicts)) {
    const nodePath = unitKey.startsWith('node:') ? unitKey.slice('node:'.length) : null;
    if (nodePath === null || !graph.nodes.has(nodePath)) delete lock.relation_verdicts[unitKey];
  }

  lock.version = LOCK_FORMAT_VERSION;
  await persistLock();
}

// ============================================================
// Worker pool (per-pair throw isolation, §7)
// ============================================================

/**
 * Run `fn` over `items` with at most `concurrency` concurrent evaluations,
 * preserving input order. A throw from one item becomes a synthetic infra
 * outcome (siblings unaffected) — never aborts the pool.
 */
async function runPairPool<T>(
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

// ============================================================
// Small utilities
// ============================================================

async function readBytesOrEmpty(absPath: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(absPath);
  } catch (e) {
    debugWrite(`[fill] readBytesOrEmpty failed for ${absPath}: ${e instanceof Error ? e.message : String(e)}`);
    return Buffer.alloc(0);
  }
}

function applySecrets(tier: LlmConfig, secrets: Partial<LlmConfig> | null | undefined): LlmConfig {
  return secrets ? mergeLlmConfig(tier, secrets) : tier;
}
