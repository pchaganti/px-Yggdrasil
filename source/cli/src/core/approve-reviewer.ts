// yg-suppress(deterministic) approve-reviewer must invoke the configured LLM provider for verification; non-determinism is intentional and inherent to this engine's purpose
import type { Graph, GraphNode, AspectDef, LlmConfig, ReviewerConfig, AspectStatus } from '../model/graph.js';
import type { ApproveResult, AspectVerificationResult, DriftNodeState, DriftIdentity } from '../model/drift.js';
import type { IssueMessage } from '../model/validation.js';
import { verifyAspects } from '../llm/aspect-verifier.js';
import { createLlmProvider } from '../llm/index.js';
import { commitApproval, loadSourceFiles, getChildMappingExclusions } from './approve.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from './graph/aspects.js';
import { buildAspectVerdicts, reviewerAborted, applyAspectVerdictsToResult } from './approve-verdicts.js';
import { collectTrackedFiles } from './graph/files.js';
import { hashTrackedFiles } from '../io/hash.js';
import { selectTierForAspect } from './tier-selection.js';
import { loadSecrets, mergeLlmConfig } from '../io/secrets-parser.js';
import { runStructureAspect, StructureRunnerError } from '../structure/runner.js';
import { debugWrite } from '../utils/debug-log.js';
import { readTextFile } from '../io/graph-fs.js';
import { clearDraftAspectsFromDriftState } from '../io/drift-state-store.js';
import { hashFile } from '../io/hash.js';
import type { ParseCache } from '../ast/parse-cache.js';
import path from 'node:path';
import { toPosixPath } from '../utils/posix.js';

/** A failed aspect: a code violation, a provider error, or a deterministic runtime error. */
type AspectViolation = { aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'checkRuntime' };

/** True when any effective aspect in the identity recorded a checkTouched set. */
function hasAnyCheckTouched(identity: DriftIdentity): boolean {
  return Object.values(identity.aspects).some((a) => a.checkTouched && Object.keys(a.checkTouched).length > 0);
}

/**
 * Run every deterministic aspect in the plan — former-ast and structure aspects
 * alike (graph-shape + fs verification, no LLM call). Records results/violations
 * and persists each aspect's touched-file hashes into
 * result.pendingDriftState.state.identity.aspects[id].checkTouched. Cross-node touched paths
 * are hashed from disk but kept OUT of state.files (see inline note).
 */
async function dispatchStructureAspects(
  plan: ExecutionPlan,
  node: GraphNode,
  graph: Graph,
  result: ApproveResult,
  projectRoot: string,
  parseCache: ParseCache,
  results: Record<string, AspectVerificationResult>,
  violations: AspectViolation[],
): Promise<void> {
  for (const entry of plan.resolved) {
    if (entry.kind !== 'deterministic') continue;
    const aspect = entry.aspect;
    const aspectDirAbs = path.join(projectRoot, '.yggdrasil/aspects', aspect.id);
    try {
      const structResult = await runStructureAspect({
        aspectDir: aspectDirAbs,
        aspectId: aspect.id,
        nodePath: node.path,
        graph,
        projectRoot,
        parseCache,
      });
      if (structResult.succeeded === false) {
        const reason = structResult.violations.map(v => v.message).join('\n') || 'structure runtime error';
        results[aspect.id] = { satisfied: false, reason, errorSource: 'checkRuntime' };
        violations.push({ aspectId: aspect.id, reason, errorSource: 'checkRuntime' });
        continue;
      }

      // Persist touched files into the pending drift state's typed identity.
      // Normalize each path to forward-slash separators before using it as a
      // drift-state key, matching every other path written at this output
      // boundary (projectRoot, yggPrefix, sourceFilePaths, normalizedNodePath).
      // runStructureAspect may return backslash-separated paths on Windows;
      // storing them verbatim would violate posix-paths-output for drift-state.
      const sourceFileHashes: Record<string, string> = {};
      for (const raw of new Set(structResult.touchedFiles)) {
        const p = toPosixPath(raw);
        let hash = result.pendingDriftState?.state.files[p];
        // A touched path absent from state.files is a CROSS-NODE read — a file
        // owned by a related node, reached via ctx.fs/ctx.graph. Hash it from
        // disk, but DO NOT inject it into state.files: state.files is the
        // canonical own source/graph map, and check.ts's deleted-file detector
        // walks it — a cross-node path there would be reported as a phantom
        // "(deleted)". Such paths live ONLY in identity.aspects[id].checkTouched
        // and re-enter the canonical hash via the recompute below.
        if (!hash) {
          const abs = path.resolve(projectRoot, p);
          try {
            hash = await hashFile(abs);
          } catch (e) {
            debugWrite(`[approve] structure aspect ${aspect.id}: cross-node touched file hash failed for ${p}: ${e instanceof Error ? e.message : String(e)}`);
            continue;
          }
        }
        sourceFileHashes[p] = hash;
      }
      /* v8 ignore next 5 -- unreachable: approve.ts no-change branch now always populates
       * pendingDriftState; approved/initial branches always set it; refused is an early-return */
      if (!result.pendingDriftState) {
        throw new Error(
          `internal: structure dispatch ran without pendingDriftState for node ${node.path}; ` +
          `caller must guarantee pendingDriftState is populated before reviewer dispatch.`,
        );
      }
      // Record this aspect's touched set under its typed identity. The aspect
      // entry exists when the aspect is effective on this node (collectTrackedFiles
      // creates it); if missing (defensive), seed a minimal one.
      const aspects = result.pendingDriftState.state.identity.aspects;
      const current = aspects[aspect.id] ?? { meta: '' };
      current.checkTouched = sourceFileHashes;
      aspects[aspect.id] = current;

      const violated = structResult.violations.length > 0;
      const reason = violated
        ? structResult.violations.map(v => {
            // Normalize the violation path to POSIX before embedding it in the
            // reason string — this reason is persisted into the drift-state
            // aspectVerdicts, an output boundary the posix-paths-output contract
            // governs (runStructureAspect may return backslash paths on Windows).
            const file = v.file ? toPosixPath(v.file) : v.file;
            const loc = file ? `${file}:${v.line ?? '?'}: ` : '';
            return `${loc}${v.message}`;
          }).join('\n')
        : 'all rules satisfied';
      results[aspect.id] = { satisfied: !violated, reason, errorSource: 'codeViolation' };
      if (violated) {
        violations.push({ aspectId: aspect.id, reason, errorSource: 'codeViolation' });
      }
    } catch (e: unknown) {
      debugWrite(`[approve] structure aspect ${aspect.id}: ${e instanceof Error ? e.message : String(e)}`);
      const code: string = (e as { code?: string }).code ?? 'STRUCTURE_RUNNER_UNKNOWN';
      const rendered = e instanceof StructureRunnerError
        ? `${e.messageData.what} — ${e.messageData.why}`
        : (e as Error).message;
      const reason = `[${code}] ${rendered}`;
      results[aspect.id] = { satisfied: false, reason, errorSource: 'checkRuntime' };
      violations.push({ aspectId: aspect.id, reason, errorSource: 'checkRuntime' });
    }
  }
}

/**
 * Commit approval and evict stale baseline verdicts for effective-draft aspects.
 * Draft aspects are dormant (skipped before reviewer dispatch), so a verdict
 * recorded before a transition to `draft` would linger though no reviewer
 * re-evaluated it; eviction keeps the persisted state to aspects the reviewer
 * actually saw. Safe no-op when there is nothing to clear.
 */
async function commitApprovalAndCleanDrafts(
  rootPath: string,
  result: ApproveResult,
  node: GraphNode,
  graph: Graph,
): Promise<void> {
  await commitApproval(rootPath, result);
  const statuses = computeEffectiveAspectStatuses(node, graph);
  const draftIds = new Set<string>();
  for (const [id, status] of statuses) {
    if (status === 'draft') draftIds.add(id);
  }
  if (draftIds.size > 0) {
    await clearDraftAspectsFromDriftState(rootPath, node.path, draftIds);
  }
}

export interface LlmApproveResult extends ApproveResult {
  aspectResults?: Record<string, AspectVerificationResult>;
  llmSkipped?: 'unavailable';
  aspectViolations?: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'checkRuntime' }>;
  /** Effective-draft aspects skipped before reviewer dispatch. Empty when none. */
  skippedDraftAspects?: string[];
  /**
   * Code violations of aspects whose effective status is `advisory`, surfaced
   * when ALL code violations on the node are advisory (zero enforced). In that
   * case the node is NOT refused — the baseline and per-aspect verdicts are
   * still recorded — but the CLI prints these as an informational line and
   * treats the node as passed for exit-code purposes. This matches advisory's
   * "warns, does not block" semantics. Absent/empty when there are no
   * advisory-only code violations.
   */
  advisoryViolations?: Array<{ aspectId: string; reason: string }>;
}

/**
 * Partition code violations (errorSource === 'codeViolation') by the violated
 * aspect's effective status on this node. Anything not present in the status
 * map defaults to `enforced` — the safe default that blocks. Infrastructure
 * errors (provider / checkRuntime) are NOT code violations and are excluded by
 * the caller before this is used; they refuse via their own branches.
 */
function partitionCodeViolationsByStatus(
  codeViolations: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'checkRuntime' }>,
  statuses: Map<string, AspectStatus>,
): {
  enforced: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'checkRuntime' }>;
  advisory: Array<{ aspectId: string; reason: string }>;
} {
  const enforced: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'checkRuntime' }> = [];
  const advisory: Array<{ aspectId: string; reason: string }> = [];
  for (const v of codeViolations) {
    const status = statuses.get(v.aspectId) ?? 'enforced';
    if (status === 'advisory') {
      advisory.push({ aspectId: v.aspectId, reason: v.reason });
    } else {
      enforced.push(v);
    }
  }
  return { enforced, advisory };
}

// ── resolveExecutionPlan ─────────────────────────────────────

export type ResolvedAspectExecution =
  | { kind: 'deterministic'; aspect: AspectDef }
  | { kind: 'llm'; aspect: AspectDef; tier: LlmConfig; tierName: string };

export interface ExecutionPlan {
  resolved: ResolvedAspectExecution[];
  errors: IssueMessage[];
}

export function resolveExecutionPlan(
  aspects: AspectDef[],
  reviewer: ReviewerConfig,
): ExecutionPlan {
  const resolved: ResolvedAspectExecution[] = [];
  const errors: IssueMessage[] = [];

  for (const aspect of aspects) {
    // Deterministic aspects run locally through the structure runner (no LLM
    // call). The reviewer.type enum is { llm, deterministic }.
    if (aspect.reviewer.type === 'deterministic') {
      resolved.push({ kind: 'deterministic', aspect });
      continue;
    }
    const r = selectTierForAspect(aspect, reviewer);
    if (!r.ok) { errors.push(r.error); continue; }
    resolved.push({ kind: 'llm', aspect, tier: r.tier, tierName: r.tierName });
  }

  return { resolved, errors };
}

// ── reference loader ────────────────────────────────────────

export interface LoadReferencesParams {
  aspectId: string;
  references: Array<{ path: string; description?: string }> | undefined;
  projectRoot: string;
  cache: Map<string, string>;
  readTextFile: (absPath: string) => Promise<string>;
}

export type LoadReferencesResult =
  | { ok: true; references: Array<{ path: string; description?: string; content: string }> }
  | { ok: false; reason: string };

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

export async function loadAndIsolateReferences(params: LoadReferencesParams): Promise<LoadReferencesResult> {
  const refs = params.references ?? [];
  if (refs.length === 0) return { ok: true, references: [] };
  const out: Array<{ path: string; description?: string; content: string }> = [];
  for (const ref of refs) {
    const absPath = path.join(params.projectRoot, ref.path);
    try {
      let content = params.cache.get(absPath);
      if (content === undefined) {
        content = stripBom(await params.readTextFile(absPath));
        params.cache.set(absPath, content);
      }
      out.push({ path: ref.path, description: ref.description, content });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      debugWrite(`[approve] reference load failed for aspect ${params.aspectId} path ${ref.path}: ${msg}`);
      return {
        ok: false,
        reason: `LLM_REFERENCE_UNREADABLE: ${ref.path} — ${msg}`,
      };
    }
  }
  return { ok: true, references: out };
}

// ── per-aspect verdict helpers ──────────────────────────────

// Per-aspect verdict construction/merge helpers live in approve-verdicts.ts
// (pure, no LLM) — kept out of this engine to keep its reviewer context within
// the node size budget. Re-exported here so existing import sites are unchanged.
export { buildAspectVerdicts, reviewerAborted, applyAspectVerdictsToResult };

// ── per-tier batching ────────────────────────────────────────

export interface ApproveWithReviewerInput {
  graph: Graph;
  nodePath: string;
  result: ApproveResult;
  /** Path to .yggdrasil/ directory (graph.rootPath). Used for secrets loading and file hashing. */
  rootPath: string;
  filterAspectId?: string;
  /** Session-scope secrets cache. Declared above the per-node loop by caller so distinct providers share one entry. */
  secretsByProvider: Map<string, Partial<LlmConfig> | null>;
  /**
   * Prior drift baseline (if any) — used to preserve per-aspect verdicts when
   * running a filtered approve (filterAspectId set). Optional; absent on first
   * approve.
   */
  storedEntry?: DriftNodeState;
  /**
   * Option 1 (per-aspect re-verification). When set (on any approve where
   * filterAspectId is undefined — --node, --flow cascade, parent-redirect),
   * restrict the reviewer dispatch to these aspect ids; every other effective
   * non-draft aspect is carried forward from the prior baseline via the existing
   * carryForward path. Ignored when filterAspectId is set. Absent → re-run all.
   */
  reReviewAspectIds?: Set<string>;
}

export async function runApproveWithReviewer(
  input: ApproveWithReviewerInput,
): Promise<LlmApproveResult> {
  const { graph, nodePath, result, rootPath, filterAspectId, secretsByProvider, storedEntry, reReviewAspectIds } = input;

  if (result.action === 'refused') return result;

  const node = graph.nodes.get(nodePath);
  if (!node) return result;

  const allAspectIds = computeEffectiveAspects(node, graph);
  const allAspects: AspectDef[] = [...allAspectIds]
    .map((id: string) => graph.aspects.find((a: AspectDef) => a.id === id))
    .filter((a): a is AspectDef => a !== undefined);

  // Filter out effective-draft aspects before reviewer dispatch.
  // Draft aspects are dormant: no baseline, no drift, no reviewer call.
  const statuses = computeEffectiveAspectStatuses(node, graph);
  const nonDraft = allAspects.filter(a => statuses.get(a.id) !== 'draft');
  const skippedDraftAspects: string[] = allAspects
    .filter(a => statuses.get(a.id) === 'draft')
    .map(a => a.id);
  for (const id of skippedDraftAspects) {
    process.stdout.write(`[draft] node '${node.path}': aspect '${id}' skipped (status: draft)\n`);
  }

  // Dispatch-set precedence: explicit --aspect (filterAspectId) wins; else the
  // Option-1 drifted subset (reReviewAspectIds); else every non-draft aspect.
  const filtered = filterAspectId
    ? nonDraft.filter(a => a.id === filterAspectId)
    : reReviewAspectIds
      ? nonDraft.filter(a => reReviewAspectIds.has(a.id))
      : nonDraft;

  // Hoisted: needed by buildAspectVerdicts in early-return paths below.
  const aspectViolations: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'checkRuntime' }> = [];
  const allAspectResults: Record<string, AspectVerificationResult> = {};
  const referencesCache = new Map<string, string>();

  // Every terminal branch funnels through here: record per-aspect verdicts,
  // commit the baseline, and return with branch-specific extras plus the always-
  // attached skippedDraftAspects. Closes over the per-run state above.
  const finalizeAndReturn = async (extras: Partial<LlmApproveResult>, infra = false): Promise<LlmApproveResult> => {
    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, allAspectResults);
    applyAspectVerdictsToResult(result, verdicts, carryForward, storedEntry?.aspectVerdicts, filterAspectId, reviewerAborted(node, graph, allAspectResults));
    // FAIL-CLOSED (#2): commit ONLY on a run with NO infra disposition. Any infra
    // failure — provider unreachable, no reviewer configured for an LLM aspect,
    // tier-resolution failure, reference-load failure, check-runtime crash, garbled
    // response — must leave the prior baseline FULLY intact (no advanced hash, no
    // draft cleanup) and end RED, so drift stays visible until a clean approve.
    // Committing on infra would clear drift while carrying the prior `approved`
    // verdict forward → the next `yg check` goes green over unverified code.
    if (!infra) {
      // H2: a refused commit must NOT advance the log-freshness baseline (it marks
      // the last SUCCESSFUL approve) — preserve the prior so one log entry still
      // covers the fix-and-retry cycle. Hash + verdicts still advance, staying red.
      const committedVerdicts = result.pendingDriftState?.state.aspectVerdicts ?? {};
      const anyRefused = Object.values(committedVerdicts).some((v) => v.verdict === 'refused');
      if (anyRefused && result.pendingDriftState) {
        if (storedEntry?.log) {
          result.pendingDriftState.state.log = storedEntry.log;
        } else {
          delete result.pendingDriftState.state.log;
        }
      }
      await commitApprovalAndCleanDrafts(rootPath, result, node, graph);
    }
    const out: LlmApproveResult = { ...result, ...extras, skippedDraftAspects };
    if (infra) out.action = 'refused';
    return out;
  };

  if (filtered.length === 0) {
    return finalizeAndReturn({});
  }

  // No reviewer configured but this node has effective non-draft LLM aspects — they
  // cannot be verified, so approving would record a verdict over unverified code.
  // Fail closed (infra): refuse, do not commit.
  const hasLlmAspects = filtered.some(a => a.reviewer.type === 'llm');
  if (!graph.config.reviewer && hasLlmAspects) {
    const llmIds = filtered.filter(a => a.reviewer.type === 'llm').map(a => a.id).join(', ');
    return finalizeAndReturn({
      action: 'refused',
      llmSkipped: 'unavailable',
      refuseReasonData: {
        what: `No reviewer is configured, but this node has effective non-draft LLM aspect(s): ${llmIds}.`,
        why: 'An LLM aspect needs a configured reviewer to be verified — approving without one would record a verdict over unverified code.',
        next: 'Add a reviewer tier in .yggdrasil/yg-config.yaml, or set the aspect(s) to status: draft until ready to enforce.',
      },
    }, true);
  }

  // Load source files
  const projectRoot = toPosixPath(path.dirname(rootPath));
  const { trackedFiles } = collectTrackedFiles(node, graph);
  const { fileHashes } = await hashTrackedFiles(projectRoot, trackedFiles, undefined, []);
  const yggPrefix = toPosixPath(path.relative(projectRoot, rootPath));
  const sourceFilePaths = Object.keys(fileHashes)
    .map(f => toPosixPath(f))
    .filter(f => !f.startsWith(yggPrefix));
  const sourceFiles = await loadSourceFiles(sourceFilePaths, projectRoot);

  // FAIL-CLOSED (#2c): LLM aspects require readable source files — the reviewer
  // must see the code it is verifying. When the resolved source-file set is empty
  // but the node has at least one effective non-draft LLM aspect, approving would
  // record a verdict over code the reviewer never saw. Refuse (infra, no commit)
  // so drift stays visible. Deterministic aspects legitimately operate on graph
  // shape, so this guard is conditioned on LLM aspects only.
  if (hasLlmAspects && sourceFilePaths.length === 0) {
    const llmIds = filtered.filter(a => a.reviewer.type === 'llm').map(a => a.id).join(', ');
    const normalizedNodePath = toPosixPath(nodePath);
    return finalizeAndReturn({
      action: 'refused',
      llmSkipped: 'unavailable',
      refuseReasonData: {
        what: `No readable source files found for node '${normalizedNodePath}', but it has effective non-draft LLM aspect(s): ${llmIds}.`,
        why: 'An LLM aspect needs source files to verify — approving with no files would record a verdict over code the reviewer never saw.',
        next: `Add source files that satisfy the node mapping, or remove the LLM aspect(s), then re-run: yg approve --node ${normalizedNodePath}`,
      },
    }, true);
  }

  const nodeDescription = node.meta.description ?? '';

  // Resolve execution plan. With no reviewer configured, only the deterministic
  // aspects can run — they take no LLM call; LLM aspects are dropped here and
  // surfaced as llmSkipped above.
  const plan: ExecutionPlan = graph.config.reviewer
    ? resolveExecutionPlan(filtered, graph.config.reviewer)
    : {
        resolved: filtered
          .filter(a => a.reviewer.type === 'deterministic')
          .map(a => ({ kind: 'deterministic' as const, aspect: a })),
        errors: [],
      };

  if (plan.errors.length > 0) {
    const normalizedNodePath = toPosixPath(nodePath);
    const why = plan.errors.map(e => [e.what, e.why].filter(Boolean).join('\n')).join('\n\n');
    return finalizeAndReturn({
      action: 'refused',
      refuseReasonData: {
        what: 'Tier resolution failed for one or more aspects.',
        why,
        next: `Fix the tier configuration in yg-config.yaml and re-run: yg approve --node ${normalizedNodePath}`,
      },
      aspectViolations: [],
    }, true); // infra — config problem, do not commit
  }

  // Deterministic aspects — former-ast and structure alike — run locally (no LLM
  // call) through the structure runner, populating results/violations.
  const astParseCache: ParseCache = new Map();
  await dispatchStructureAspects(plan, node, graph, result, projectRoot, astParseCache, allAspectResults, aspectViolations);

  // Preserve checkTouched for deterministic aspects that were NOT freshly
  // evaluated this run. Both former-ast and structure aspects now run through
  // the structure runner and write a checkTouched entry, so both must be
  // carried forward. Two cases collapse into one pass:
  //   - draft-skipped: a deterministic aspect toggled to draft retains its prior
  //     entry so a later enforced→draft→enforced cycle does not cascade drift.
  //   - filter-excluded: a filtered approve (`yg approve --aspect X`) runs only
  //     X's runner; a neighbor enforced/advisory deterministic aspect's prior
  //     entry must be carried forward, otherwise its touched files silently drop
  //     out of the node's drift identity and impact blast-radius.
  // An aspect was "freshly evaluated" iff it survived the draft + filter passes
  // (i.e. it is in `filtered`); only those produce a new entry this run.
  if (storedEntry && result.pendingDriftState) {
    const aspectsState = result.pendingDriftState.state.identity.aspects;
    const aspectById = new Map<string, AspectDef>();
    for (const a of allAspects) aspectById.set(a.id, a);
    const freshlyEvaluated = new Set(filtered.map(a => a.id));
    let preserved = 0;
    for (const [id, prior] of Object.entries(storedEntry.identity.aspects)) {
      if (!prior.checkTouched) continue;
      if (freshlyEvaluated.has(id)) continue; // a fresh entry was produced this run
      const aspect = aspectById.get(id);
      // Only deterministic aspects produce checkTouched entries.
      if (aspect?.reviewer.type !== 'deterministic') continue;
      const current = aspectsState[id];
      if (!current) continue;                  // aspect no longer effective
      if (current.checkTouched) continue;      // already carried (defensive)
      current.checkTouched = prior.checkTouched;
      preserved += 1;
    }
    if (preserved > 0) {
      debugWrite(`[d8.3] preserved checkTouched for ${preserved} non-evaluated deterministic aspect(s) on node ${node.path}`);
    }
  }

  // Recompute the canonical drift hash to fold in the deterministic read-sets.
  // approveNode computed state.hash BEFORE the structure runner ran, so on a
  // NEW baseline (action initial/approved) the cross-node files just recorded in
  // identity.aspects[id].checkTouched are not yet part of the node's drift
  // identity. Re-collect WITH the now-populated baseline so collectTrackedFiles
  // carries the checkTouched maps into a fresh identity, re-hash with that
  // identity, and adopt BOTH the canonical hash and the recomputed identity (so
  // a later `yg check` recomputes the same identity from the same baseline and
  // sees no drift). Skip on no-change/refused: those do not write a fresh baseline.
  if (
    result.pendingDriftState &&
    (result.action === 'initial' || result.action === 'approved') &&
    hasAnyCheckTouched(result.pendingDriftState.state.identity)
  ) {
    const { trackedFiles: recomputeTracked, identity: recomputeIdentity } =
      collectTrackedFiles(node, graph, result.pendingDriftState.state);
    const recomputeExclusions = getChildMappingExclusions(graph, node.path);
    const { canonicalHash } =
      await hashTrackedFiles(projectRoot, recomputeTracked, undefined, recomputeExclusions, recomputeIdentity);
    result.pendingDriftState.state.identity = recomputeIdentity;
    result.pendingDriftState.state.hash = canonicalHash;
    result.currentHash = canonicalHash;
  }

  // AST/structure short-circuit refusal. Refuse early (skipping LLM dispatch)
  // ONLY when something here MUST block: an infrastructure crash (checkRuntime)
  // or a code violation of an ENFORCED aspect. If every violation so far is a
  // code violation of an advisory-only aspect, do NOT short-circuit — let the
  // LLM aspects run and let the final status-aware decision below surface the
  // advisory violations without refusing.
  if (aspectViolations.length > 0) {
    const astInfraErrors = aspectViolations.filter(v => v.errorSource !== 'codeViolation');
    const astCodeViolations = aspectViolations.filter(v => v.errorSource === 'codeViolation');
    const { enforced: enforcedAstCode } = partitionCodeViolationsByStatus(astCodeViolations, statuses);
    if (astInfraErrors.length > 0 || enforcedAstCode.length > 0) {
      const normalizedNodePath = toPosixPath(nodePath);
      // A check-runtime crash / infra error is NOT a code issue → do not commit
      // (fail closed). A pure enforced code violation DOES commit a refused verdict.
      const isInfra = astInfraErrors.length > 0;
      return finalizeAndReturn({
        action: 'refused',
        refuseReasonData: isInfra
          ? {
              what: `A deterministic check failed to run for ${astInfraErrors.length} aspect(s): ${[...new Set(astInfraErrors.map(v => v.aspectId))].join(', ')}.`,
              why: 'The check.mjs crashed or returned an invalid result — an infrastructure problem in the check, not a code violation.',
              next: `Fix the check.mjs, then re-run: yg approve --node ${normalizedNodePath}`,
            }
          : {
              what: 'Reviewer found aspect violations.',
              why: 'One or more aspects were not satisfied by the source code.',
              next: `Fix the violations and re-run: yg approve --node ${normalizedNodePath}`,
            },
        aspectResults: allAspectResults,
        aspectViolations,
      }, isInfra);
    }
  }

  // LLM aspects grouped by tier
  type LlmEntry = Extract<ResolvedAspectExecution, { kind: 'llm' }>;
  const llmEntries = plan.resolved.filter((e): e is LlmEntry => e.kind === 'llm');

  if (llmEntries.length === 0) {
    // No LLM aspects ran. Any violations reaching here are advisory-only code
    // violations from AST/structure (enforced/infra short-circuited above) —
    // surface them so the CLI prints the informational line without refusing.
    const { advisory: advisoryCodeViolations } =
      partitionCodeViolationsByStatus(aspectViolations.filter(v => v.errorSource === 'codeViolation'), statuses);
    return finalizeAndReturn({
      aspectResults: allAspectResults,
      advisoryViolations: advisoryCodeViolations.length > 0 ? advisoryCodeViolations : undefined,
    });
  }

  const aspectsByTier = new Map<string, LlmEntry[]>();
  for (const e of llmEntries) {
    const list = aspectsByTier.get(e.tierName) ?? [];
    list.push(e);
    aspectsByTier.set(e.tierName, list);
  }

  async function getMergedTier(tier: LlmConfig): Promise<LlmConfig> {
    if (!secretsByProvider.has(tier.provider)) {
      const secrets = await loadSecrets(rootPath, tier.provider);
      secretsByProvider.set(tier.provider, secrets ?? null);
    }
    const s = secretsByProvider.get(tier.provider);
    return s ? mergeLlmConfig(tier, s) : tier;
  }

  function aspectContent(aspect: AspectDef): string {
    return aspect.artifacts
      .filter(a => a.filename.endsWith('.md'))
      .map(a => a.content)
      .join('\n\n');
  }

  for (const [tierName, entries] of aspectsByTier) {
    for (const entry of entries) {
      debugWrite(
        `[tier-selection] node=${nodePath} aspect=${entry.aspect.id} ` +
        `tier=${tierName} provider=${entries[0].tier.provider} ` +
        `model=${entries[0].tier.model} consensus=${entries[0].tier.consensus}`,
      );
    }

    const tier = entries[0].tier;
    const merged = await getMergedTier(tier);
    const provider = createLlmProvider(merged);

    if (!(await provider.isAvailable())) {
      // LLM provider unreachable — an infrastructure failure, not a code issue.
      // Fail closed: refuse, do not commit (so drift stays visible). A co-occurring
      // advisory code violation is not surfaced this cycle — the node is red on infra.
      const np = toPosixPath(nodePath);
      return finalizeAndReturn({
        action: 'refused',
        llmSkipped: 'unavailable',
        refuseReasonData: {
          what: 'Reviewer provider is unreachable.',
          why: 'The configured reviewer endpoint did not respond (availability check failed) — an infrastructure problem, not a code violation.',
          next: `Check the provider endpoint, network, and credentials, then re-run: yg approve --node ${np}`,
        },
        aspectResults: allAspectResults,
      }, true);
    }

    // Load references per-aspect with failure isolation
    const aspectsForTier: Array<{
      id: string;
      description: string;
      content: string;
      references?: Array<{ path: string; description?: string; content: string }>;
    }> = [];
    for (const e of entries) {
      const loaded = await loadAndIsolateReferences({
        aspectId: e.aspect.id,
        references: e.aspect.references,
        projectRoot,
        cache: referencesCache,
        readTextFile,
      });
      if (!loaded.ok) {
        allAspectResults[e.aspect.id] = { satisfied: false, reason: loaded.reason, errorSource: 'provider' };
        aspectViolations.push({ aspectId: e.aspect.id, reason: loaded.reason, errorSource: 'provider' });
        continue;
      }
      aspectsForTier.push({
        id: e.aspect.id,
        description: e.aspect.description ?? e.aspect.name,
        content: aspectContent(e.aspect),
        references: loaded.references.length > 0 ? loaded.references : undefined,
      });
    }

    if (aspectsForTier.length === 0) continue;

    const llmResults = await verifyAspects({
      provider,
      aspects: aspectsForTier,
      sourceFiles,
      nodePath,
      nodeDescription,
      consensus: merged.consensus,
    });

    for (const [aspectId, res] of Object.entries(llmResults)) {
      allAspectResults[aspectId] = res;
      if (!res.satisfied) {
        aspectViolations.push({ aspectId, reason: res.reason, errorSource: res.errorSource });
      }
    }
  }

  const infrastructureErrors = aspectViolations.filter(v => v.errorSource !== 'codeViolation');
  const codeViolations = aspectViolations.filter(v => v.errorSource === 'codeViolation');
  const normalizedNodePath = toPosixPath(nodePath);

  // Check for reference-load failures first — distinct message, takes precedence over generic infra error
  const referenceFailures = aspectViolations.filter(v => v.reason.startsWith('LLM_REFERENCE_UNREADABLE'));
  if (referenceFailures.length > 0 && codeViolations.length === 0) {
    return finalizeAndReturn({
      action: 'refused',
      refuseReasonData: {
        what: `Reference file load failed for ${referenceFailures.length} aspect(s): ${referenceFailures.map(f => f.aspectId).join(', ')}.`,
        why: 'one or more aspects declare references that could not be read at approve time. Earlier failures are listed above with the file path and syscall reason.',
        next: `restore the missing reference file(s), fix the path in the aspect yg-aspect.yaml, or remove the reference. Then re-run: yg approve --node ${normalizedNodePath}`,
      },
      aspectResults: allAspectResults,
      aspectViolations,
    }, true); // infra — reference unreadable, do not commit
  }

  if (infrastructureErrors.length > 0 && codeViolations.length === 0) {
    return finalizeAndReturn({
      action: 'refused',
      refuseReasonData: {
        what: 'Reviewer infrastructure failed — this is not a code issue.',
        why: 'provider connection or authentication error, not a code violation.',
        next: 'Check your API key and provider configuration.',
      },
      aspectResults: allAspectResults,
      aspectViolations,
    }, true); // infra — do not commit
  }

  // Final code-violations decision — status-aware.
  //
  // Reaching here means there is ≥1 code violation (the infra-only and
  // reference-only branches above already returned for the codeViolations === 0
  // cases). Partition the code violations by effective aspect status:
  //   - ≥1 ENFORCED code violation, OR any remaining infrastructure error →
  //     refuse (exit 1), as before. Infra failures always block.
  //   - ALL code violations are ADVISORY (zero enforced, zero infra) → do NOT
  //     refuse. The baseline and per-aspect verdicts are recorded just like an
  //     approved node; the advisory violations are surfaced on the result so
  //     the CLI can print an informational line and `yg check` still renders
  //     them as non-blocking warnings. This matches advisory's "warns, does
  //     not block" semantics.
  if (aspectViolations.length > 0) {
    const { enforced: enforcedCodeViolations, advisory: advisoryCodeViolations } =
      partitionCodeViolationsByStatus(codeViolations, statuses);

    if (infrastructureErrors.length > 0 || enforcedCodeViolations.length > 0) {
      // Infra dominates the commit decision: any infra error → do not commit (fail
      // closed). A pure enforced code violation still commits its refused verdict.
      const isInfra = infrastructureErrors.length > 0;
      return finalizeAndReturn({
        action: 'refused',
        refuseReasonData: isInfra
          ? {
              what: 'Reviewer infrastructure failed — this is not a code issue.',
              why: 'A provider/connection/runtime error occurred while verifying one or more aspects.',
              next: `Resolve the infrastructure problem (see above), then re-run: yg approve --node ${normalizedNodePath}`,
            }
          : {
              what: 'Reviewer found aspect violations.',
              why: 'One or more aspects were not satisfied by the source code.',
              next: `Fix the violations and re-run: yg approve --node ${normalizedNodePath}`,
            },
        aspectResults: allAspectResults,
        aspectViolations,
      }, isInfra);
    }

    // Advisory-only code violations: preserve the approved-family action.
    return finalizeAndReturn({
      aspectResults: allAspectResults,
      advisoryViolations: advisoryCodeViolations,
    });
  }

  return finalizeAndReturn({ aspectResults: allAspectResults });
}
