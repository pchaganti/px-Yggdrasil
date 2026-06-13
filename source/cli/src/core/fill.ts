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
import { LOCK_FORMAT_VERSION } from '../model/lock.js';
import type { CheckResult } from './check.js';
import { runCheck } from './check.js';
import { readLock, writeLock } from '../io/lock-store.js';
import { computeExpectedPairs, computeSourceFingerprint } from './pairs.js';
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
import { readTextFile } from '../io/graph-fs.js';
import {
  hasFreshLogEntry,
  computeLogBaselineForNode,
  readLogContent,
} from './log/log-gate.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';

// ============================================================
// Public surface
// ============================================================

export interface RunFillOptions {
  /** Git-tracked files for the final coverage scan (mirrors plain check). Pass
   *  null to skip the unmapped-files check (no git available). */
  gitTrackedFiles: string[] | null;
  /** Sink for agent-facing fill output. Defaults to process.stdout.write. */
  write?: (s: string) => void;
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
  const projectRoot = path.dirname(graph.rootPath);

  // ── Step 1: Structural gate. A gating code aborts the whole fill. ──────────
  const validation = await validate(graph);
  const gating = validation.issues.filter(
    (i) => i.code !== undefined && APPROVE_GATING_CODES.has(i.code),
  );
  if (gating.length > 0) {
    const details = gating.map((i) => buildIssueMessage(i.messageData)).join('\n\n');
    write(
      buildIssueMessage({
        what: 'yg check --approve aborted — configuration errors block tier resolution.',
        why: details,
        next: 'Fix the errors above, then re-run: yg check --approve',
      }) + '\n\n',
    );
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

  // ── Step 4: Log gate per node (§9). Nodes owning unverified pairs whose ────
  // log_required type drifted (or first verification) with no fresh entry are
  // BLOCKED: their pairs are skipped; other nodes proceed.
  const blockedNodes = new Set<string>();
  for (const nodePath of nodeSet) {
    const node = graph.nodes.get(nodePath);
    if (!node) continue;
    const blocked = await logGateBlocks(graph, projectRoot, node, lock, write);
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
    const outcome = await fillDetPair(graph, projectRoot, pair, aspect, write);
    if (outcome.kind === 'runtime-error') {
      runtimeErrors += 1;
      // No write — pair stays unverified, reported as aspect-check-runtime-error.
      continue;
    }
    // Real verdict — write the entry.
    await setEntry(pair.aspectId, pair.unitKey, outcome.entry);
    write(`  [det] ${pair.aspectId} on ${pair.unitKey} — ${outcome.entry.verdict}\n`);
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
    write(
      buildIssueMessage({
        what: `LLM fills for node '${toPosixPath(nodePath)}' skipped — an enforced deterministic check already refused it.`,
        why: 'A free deterministic check rejects this node, so paying the reviewer to read the same code would be wasted. Fix the deterministic violations first.',
        next: `Fix the deterministic violations on '${toPosixPath(nodePath)}', then re-run: yg check --approve`,
      }) + '\n',
    );
  }

  // ── Step 6: LLM fills — grouped by resolved tier; one provider per tier. ───
  const secretsByProvider = new Map<string, Partial<LlmConfig> | null>();
  const referencesCache = new Map<string, string | null>(); // path → content or null (missing)

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
      write(
        buildIssueMessage({
          what: `Cannot resolve a reviewer tier for aspect '${pair.aspectId}' on ${pair.unitKey} — left unverified.`,
          why: tierResult && !tierResult.ok ? tierResult.error.why : 'No reviewer is configured for an effective non-draft LLM aspect.',
          next: tierResult && !tierResult.ok ? tierResult.error.next : 'Add a reviewer tier in .yggdrasil/yg-config.yaml, or set the aspect to status: draft.',
        }) + '\n',
      );
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
      write(
        buildIssueMessage({
          what: `Reviewer provider '${merged.provider}' (tier '${tierName}') is unreachable — ${group.length} pair(s) left unverified.`,
          why: 'The configured reviewer endpoint did not respond (availability check failed) — an infrastructure problem, not a code violation. No verdict was written.',
          next: `Check the provider endpoint, network, and credentials, then re-run: yg check --approve`,
        }) + '\n',
      );
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
        write(
          buildIssueMessage({
            what: `Reviewer could not verify aspect '${item.pair.aspectId}' on ${item.pair.unitKey} — left unverified.`,
            why: outcome.why,
            next: `Resolve the provider/config problem, then re-run: yg check --approve`,
          }) + '\n',
        );
        continue;
      }
      await setEntry(item.pair.aspectId, item.pair.unitKey, outcome.entry);
      write(`  [llm] ${item.pair.aspectId} on ${item.pair.unitKey} — ${outcome.entry.verdict}\n`);
    }
  }

  // ── Step 7: Positive closure (§7.5). ──────────────────────────────────────
  // Re-classify against the POST-FILL lock so closure sees the verdicts just
  // written. A node with a missing/stale fingerprint closes (records source +
  // log baseline) only when ALL its enforced effective pairs are approved.
  // Deliberate post-fill re-classification: must see freshly-written verdicts —
  // do not thread step-2 (pre-fill verifyLock) results through.
  await applyPositiveClosure(graph, projectRoot, lock, persistLock);

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
    write(
      buildIssueMessage({
        what: `${infraFailures} pairs failed on provider/config errors — re-running will not help until the connection/config is fixed${ids ? ` (${ids})` : ''}.`,
        why: 'These pairs hit an infrastructure disposition (provider unreachable, tier unresolved, reference unreadable, or an unparseable response). No verdict was written; the pairs stay unverified and the run ends red.',
        next: 'Fix the reviewer connection/configuration, then re-run: yg check --approve. To unblock CI without a reviewer, set the affected aspect(s) to status: draft.',
      }) + '\n',
    );
  }
  if (runtimeErrors > 0) {
    write(
      buildIssueMessage({
        what: `${runtimeErrors} deterministic check(s) failed to run at fill time — left unverified (aspect-check-runtime-error).`,
        why: 'A check.mjs crashed, returned an invalid result, or observed a file that changed mid-run. No verdict was written.',
        next: 'Fix the failing check.mjs, then re-run: yg check --approve.',
      }) + '\n',
    );
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
 * True when a node's pairs must be SKIPPED for a missing mandatory log entry
 * (spec §9): the type opts into log_required (default false) AND the current
 * source fingerprint differs from the stored one (or none is stored and the
 * mapping is non-empty — first verification) AND no fresh log entry exists.
 * Emits the `log-entry-missing` message when it blocks.
 */
async function logGateBlocks(
  graph: Graph,
  projectRoot: string,
  node: GraphNode,
  lock: LockFile,
  write: (s: string) => void,
): Promise<boolean> {
  // The default lives HERE and only here (spec §9): false unless the type opts in.
  const archType = graph.architecture.node_types[node.meta.type];
  const logRequired = archType?.log_required ?? false;
  if (!logRequired) return false;

  const currentFingerprint = await computeSourceFingerprint(graph, node.path);
  // A mapping-less node has a constant (undefined) fingerprint — the gate never
  // fires for it (§9). A node with a non-empty mapping but no stored fingerprint
  // is a first verification (drifted = true).
  if (currentFingerprint === undefined) return false;
  const storedFingerprint = lock.nodes[node.path]?.source;
  const drifted = currentFingerprint !== storedFingerprint;
  if (!drifted) return false;

  const logContent = await readLogContent(projectRoot, node.path);
  if (hasFreshLogEntry(logContent, lock.nodes[node.path]?.log)) return false;

  write(
    buildIssueMessage({
      what: `No fresh log entry for node '${toPosixPath(node.path)}' — mandatory before --approve when source changed.`,
      why: `Node type '${node.meta.type}' has log_required: true — every source change needs a justification entry capturing WHY. This node's pairs are skipped this run; other nodes proceed.`,
      next: `yg log add --node ${toPosixPath(node.path)} --reason '<justification>', then re-run: yg check --approve`,
    }) + '\n',
  );
  return true;
}

// ============================================================
// Deterministic fill
// ============================================================

type DetFillOutcome =
  | { kind: 'verdict'; entry: VerdictEntry }
  | { kind: 'runtime-error' };

/**
 * Fill one deterministic pair. Runs check.mjs through the structure runner with
 * the per-file subjectScope for a `per: file` pair (contract #8). MANDATORY A6
 * carry-overs:
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
  write: (s: string) => void,
): Promise<DetFillOutcome> {
  const aspectDirAbs = path.join(projectRoot, '.yggdrasil', 'aspects', aspect.id);
  // per: file → scope the subject to exactly this file; per: node → full mapping.
  const subjectScope = (aspect.scope?.per === 'file') ? pair.subjectFiles : undefined;

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
    write(detRuntimeNotice(aspect.id, pair.unitKey, run.rendered));
    return { kind: 'runtime-error' };
  }
  if (run.result.succeeded === false) {
    const reason = run.result.violations.map((v) => v.message).join('\n') || 'check runtime error';
    write(detRuntimeNotice(aspect.id, pair.unitKey, reason));
    return { kind: 'runtime-error' };
  }
  // A6 carry-over (2): a tainted observation set must never be cached — a file
  // changed mid-run. Re-run once; if it taints again, fail closed (no write).
  if (run.result.observationsTainted) {
    run = await runOnce();
    if (!run.ok) {
      write(detRuntimeNotice(aspect.id, pair.unitKey, run.rendered));
      return { kind: 'runtime-error' };
    }
    if (run.result.succeeded === false || run.result.observationsTainted) {
      write(detRuntimeNotice(aspect.id, pair.unitKey, 'observations remained inconsistent across two runs (a file changed mid-check)'));
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

function detRuntimeNotice(aspectId: string, unitKey: string, reason: string): string {
  return buildIssueMessage({
    what: `Deterministic check '${aspectId}' failed to run on ${unitKey} — left unverified (aspect-check-runtime-error).`,
    why: `The check.mjs crashed, returned an invalid result, or its observations changed mid-run: ${reason}`,
    next: `Fix the check.mjs, then re-run: yg check --approve`,
  }) + '\n';
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
  referencesCache: Map<string, string | null>,
): Promise<LlmFillOutcome> {
  // ── Load subject file bytes (sorted by path is the pair's contract). ──
  const subjects: Array<{ path: string; bytes: Buffer }> = [];
  for (const rel of pair.subjectFiles) {
    const bytes = await readBytesOrEmpty(path.resolve(projectRoot, rel));
    subjects.push({ path: rel, bytes });
  }

  // ── Load references; a missing reference is a LOUD infra failure (#6). ──
  const refInputs = aspect.references ?? [];
  const referencesForHash: Array<[string, string, string]> = [];
  const referencesForPrompt: PromptReferenceInput[] = [];
  for (const ref of refInputs) {
    const absRef = path.resolve(projectRoot, ref.path);
    let content = referencesCache.get(absRef);
    if (content === undefined) {
      try {
        content = stripBom(await readTextFile(absRef));
      } catch (e) {
        debugWrite(`[fill] reference load failed for ${aspect.id} path ${ref.path}: ${e instanceof Error ? e.message : String(e)}`);
        content = null;
      }
      referencesCache.set(absRef, content);
    }
    if (content === null) {
      // Never hash over empty-substituted bytes — fail closed.
      return { kind: 'infra', why: `reference '${toPosixPath(ref.path)}' for aspect '${aspect.id}' could not be read`, callsMade: 0 };
    }
    const refBytes = Buffer.from(content, 'utf8');
    referencesForHash.push([ref.path, hashBytes(refBytes), ref.description ?? '']);
    referencesForPrompt.push({ path: ref.path, description: ref.description, content });
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
 * For every node with a missing/stale source fingerprint, record its fingerprint
 * + log baseline IFF all its enforced effective pairs (both kinds) are approved
 * in the POST-FILL lock. Advisory refusals never block closure; a node with no
 * pairs closes vacuously. Mirrors the legacy absent-log handling: when log.md is
 * absent the log baseline is simply omitted (the source fingerprint still
 * records).
 */
async function applyPositiveClosure(
  graph: Graph,
  projectRoot: string,
  lock: LockFile,
  persistLock: () => Promise<void>,
): Promise<void> {
  // Re-classify against the post-fill lock to see the verdicts just written.
  const { pairs } = await computeExpectedPairs(graph);
  const byNode = new Map<string, ExpectedPair[]>();
  for (const p of pairs) {
    const list = byNode.get(p.nodePath) ?? [];
    list.push(p);
    byNode.set(p.nodePath, list);
  }

  let mutated = false;
  for (const nodePath of graph.nodes.keys()) {
    const currentFingerprint = await computeSourceFingerprint(graph, nodePath);
    if (currentFingerprint === undefined) {
      // Mapping-less node: no source fingerprint to record. Its log baseline is
      // still recorded at closure if a log.md exists (spec §9).
      await closeLogBaselineOnly(projectRoot, nodePath, lock);
      mutated = true;
      continue;
    }
    const stored = lock.nodes[nodePath]?.source;
    if (currentFingerprint === stored) continue; // fingerprint current — nothing to close

    // All enforced effective pairs of this node must be approved in the lock.
    const nodePairs = byNode.get(nodePath) ?? [];
    const allEnforcedApproved = nodePairs
      .filter((p) => p.status === 'enforced')
      .every((p) => lock.verdicts[p.aspectId]?.[p.unitKey]?.verdict === 'approved');
    if (!allEnforcedApproved) continue; // a red enforced pair keeps the cycle open

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
 * Prune verdict entries whose pair is no longer in the expected universe
 * (includeDraft: true — draft pairs keep their entries) and `nodes` entries for
 * node paths absent from the graph, then rewrite canonically.
 */
async function garbageCollectAndRewrite(
  graph: Graph,
  lock: LockFile,
  persistLock: () => Promise<void>,
): Promise<void> {
  const { pairs } = await computeExpectedPairs(graph, { includeDraft: true });
  const universe = new Set<string>(); // `${aspectId}\0${unitKey}`
  for (const p of pairs) universe.add(`${p.aspectId}\0${p.unitKey}`);

  // Prune verdicts ∉ universe.
  for (const aspectId of Object.keys(lock.verdicts)) {
    const unitMap = lock.verdicts[aspectId];
    for (const unitKey of Object.keys(unitMap)) {
      if (!universe.has(`${aspectId}\0${unitKey}`)) delete unitMap[unitKey];
    }
    if (Object.keys(unitMap).length === 0) delete lock.verdicts[aspectId];
  }

  // Prune nodes for absent node paths.
  for (const nodePath of Object.keys(lock.nodes)) {
    if (!graph.nodes.has(nodePath)) delete lock.nodes[nodePath];
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

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

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
