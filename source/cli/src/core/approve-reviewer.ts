// yg-suppress(deterministic) approve-reviewer must invoke the configured LLM provider for verification; non-determinism is intentional and inherent to this engine's purpose
import type { Graph, GraphNode, AspectDef, LlmConfig, ReviewerConfig, AspectStatus } from '../model/graph.js';
import type { ApproveResult, AspectVerdict, AspectVerificationResult, DriftNodeState } from '../model/drift.js';
import type { IssueMessage } from '../model/validation.js';
import { verifyAspects } from '../llm/aspect-verifier.js';
import { resolveMaxTokens } from '../llm/api-utils.js';
import { createLlmProvider } from '../llm/index.js';
import { commitApproval, loadSourceFiles, getChildMappingExclusions } from './approve.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from './graph/aspects.js';
import { collectTrackedFiles } from './graph/files.js';
import { hashTrackedFiles } from '../io/hash.js';
import { selectTierForAspect } from './tier-selection.js';
import { loadSecrets, mergeLlmConfig } from '../io/secrets-parser.js';
import { runAstAspect, AstRunnerError } from '../ast/runner.js';
import { runStructureAspect, StructureRunnerError } from '../structure/runner.js';
import { debugWrite } from '../utils/debug-log.js';
import { readTextFile } from '../io/graph-fs.js';
import { clearDraftAspectsFromDriftState } from '../io/drift-state-store.js';
import { hashFile } from '../io/hash.js';
import type { ParseCache } from '../ast/parse-cache.js';
import path from 'node:path';

/** A failed aspect: a code violation, a provider error, or an AST/structure runtime error. */
type AspectViolation = { aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'astRuntime' };

/**
 * Run every AST aspect in the plan (no LLM call), recording each result in
 * `results` and any violation (code or astRuntime) in `violations`.
 */
async function dispatchAstAspects(
  plan: ExecutionPlan,
  sourceFiles: Array<{ path: string; content: string }>,
  projectRoot: string,
  parseCache: ParseCache,
  results: Record<string, AspectVerificationResult>,
  violations: AspectViolation[],
): Promise<void> {
  for (const entry of plan.resolved) {
    if (entry.kind !== 'ast') continue;
    const aspect = entry.aspect;
    try {
      const astResult = await runAstAspect({
        aspectDir: path.join('.yggdrasil/aspects', aspect.id),
        aspectId: aspect.id,
        files: sourceFiles.map(f => ({ path: f.path })),
        projectRoot,
        parseCache,
      });
      const violated = astResult.violations.length > 0;
      const reason = violated
        ? astResult.violations.map(v => `${v.file}:${v.line}: ${v.message}`).join('\n')
        : 'all rules satisfied';
      results[aspect.id] = { satisfied: !violated, reason, errorSource: 'codeViolation' };
      if (violated) {
        violations.push({ aspectId: aspect.id, reason, errorSource: 'codeViolation' });
      }
    } catch (e: unknown) {
      debugWrite(`[approve] ast aspect ${aspect.id}: ${e instanceof Error ? e.message : String(e)}`);
      const code: string = (e as { code?: string }).code ?? 'AST_RUNNER_UNKNOWN';
      const rendered = e instanceof AstRunnerError
        ? `${e.messageData.what} — ${e.messageData.why}`
        : (e as Error).message;
      const reason = `[${code}] ${rendered}`;
      results[aspect.id] = { satisfied: false, reason, errorSource: 'astRuntime' };
      violations.push({ aspectId: aspect.id, reason, errorSource: 'astRuntime' });
    }
  }
}

/**
 * Run every structure aspect in the plan (graph-shape + fs verification, no LLM
 * call), recording results/violations and persisting each aspect's touched-file
 * hashes into result.pendingDriftState.state.structureTouchedFiles. Cross-node
 * touched paths are hashed from disk but kept OUT of state.files (see inline note).
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
    if (entry.kind !== 'structure') continue;
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
        results[aspect.id] = { satisfied: false, reason, errorSource: 'astRuntime' };
        violations.push({ aspectId: aspect.id, reason, errorSource: 'astRuntime' });
        continue;
      }

      // Persist touched files into the pending drift state. Normalize each
      // path to forward-slash separators before using it as a drift-state key,
      // matching every other path written at this output boundary (projectRoot,
      // yggPrefix, sourceFilePaths, normalizedNodePath). runStructureAspect may
      // return backslash-separated paths on Windows; storing them verbatim
      // would violate the posix-paths-output contract for drift-state files.
      const sourceFileHashes: Record<string, string> = {};
      for (const raw of new Set(structResult.touchedFiles)) {
        const p = raw.replace(/\\/g, '/').replace(/\/+$/, '');
        let hash = result.pendingDriftState?.state.files[p];
        // A touched path absent from state.files is a CROSS-NODE read — a file
        // owned by a related node, reached via ctx.fs/ctx.graph. Hash it from
        // disk, but DO NOT inject it into state.files: state.files is the
        // canonical own source/graph map, and check.ts's deleted-file detector
        // walks it — a cross-node path there would be reported as a phantom
        // "(deleted)". Such paths live ONLY in structureTouchedFiles and
        // re-enter the canonical hash via the structure-touched recompute below.
        if (!hash) {
          const abs = path.resolve(projectRoot, p);
          try {
            hash = await hashFile(abs);
          } catch {
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
      const stf = result.pendingDriftState.state.structureTouchedFiles ?? {};
      stf[aspect.id] = sourceFileHashes;
      result.pendingDriftState.state.structureTouchedFiles = stf;

      const violated = structResult.violations.length > 0;
      const reason = violated
        ? structResult.violations.map(v => {
            const loc = v.file ? `${v.file}:${v.line ?? '?'}: ` : '';
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
      results[aspect.id] = { satisfied: false, reason, errorSource: 'astRuntime' };
      violations.push({ aspectId: aspect.id, reason, errorSource: 'astRuntime' });
    }
  }
}

/**
 * Commit approval and evict any stale baseline entries for effective-draft
 * aspects on this node. Called after every commitApproval site in this file.
 *
 * Why eviction is needed: draft aspects are dormant (skipped before reviewer
 * dispatch), so if a prior approve recorded a verdict for an
 * aspect that has since transitioned to `draft`, that verdict would linger in
 * the baseline despite no reviewer ever evaluating it again. The cleanup
 * removes those orphaned verdicts so the persisted state reflects only
 * aspects the reviewer actually saw.
 *
 * Note: in the all-draft case the approve path short-circuits earlier
 * (filtered.length === 0) — this helper still runs there and is a safe no-op
 * when there are no prior verdicts to clear.
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
  aspectViolations?: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'astRuntime' }>;
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
 * errors (provider / astRuntime) are NOT code violations and are excluded by
 * the caller before this is used; they refuse via their own branches.
 */
function partitionCodeViolationsByStatus(
  codeViolations: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'astRuntime' }>,
  statuses: Map<string, AspectStatus>,
): {
  enforced: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'astRuntime' }>;
  advisory: Array<{ aspectId: string; reason: string }>;
} {
  const enforced: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'astRuntime' }> = [];
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
  | { kind: 'ast'; aspect: AspectDef }
  | { kind: 'llm'; aspect: AspectDef; tier: LlmConfig; tierName: string }
  | { kind: 'structure'; aspect: AspectDef };

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
    if (aspect.reviewer.type === 'ast') {
      resolved.push({ kind: 'ast', aspect });
      continue;
    }
    if (aspect.reviewer.type === 'structure') {
      resolved.push({ kind: 'structure', aspect });
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

/**
 * Build per-aspect verdicts from reviewer results.
 *
 * Captures the verdict for every non-draft effective aspect that the reviewer
 * evaluated. Draft aspects are skipped — they were never dispatched. Aspects
 * absent from allAspectResults (e.g. when no reviewer ran) are also skipped.
 */
export function buildAspectVerdicts(
  node: GraphNode,
  graph: Graph,
  allAspectResults: Record<string, AspectVerificationResult>,
): { verdicts: Record<string, AspectVerdict>; carryForward: string[] } {
  const statuses = computeEffectiveAspectStatuses(node, graph);
  const verdicts: Record<string, AspectVerdict> = {};
  // Effective non-draft aspects that this run could NOT validly evaluate — an
  // infra error (provider/runner failure, unreadable reference) or no reviewer
  // result at all. Their prior baseline verdict must be carried forward rather
  // than dropped (see applyAspectVerdictsToResult), so a transient failure never
  // wipes a known-good verdict nor becomes a durable CI-blocking refusal.
  const carryForward: string[] = [];
  for (const [aspectId, status] of statuses) {
    if (status === 'draft') continue;
    const res = allAspectResults[aspectId];
    if (res === undefined) {
      // Effective non-draft aspect with no reviewer result this run.
      carryForward.push(aspectId);
    } else if (res.satisfied === false) {
      if (res.errorSource !== 'codeViolation') {
        // Infra error — not a code violation.
        carryForward.push(aspectId);
        continue;
      }
      verdicts[aspectId] = { verdict: 'refused', reason: res.reason, errorSource: res.errorSource };
    } else if (res.satisfied === true) {
      verdicts[aspectId] = { verdict: 'approved' };
    }
  }
  return { verdicts, carryForward };
}

/**
 * Detect a reviewer abort: the node has non-draft effective aspects but
 * `allAspectResults` is empty (no reviewer call landed any verdict — e.g.
 * tier-resolution failed before any aspect ran). On abort we must NOT
 * clobber prior `aspectVerdicts` in the baseline; the prior state remains
 * authoritative until a successful re-approve produces fresh verdicts.
 */
export function reviewerAborted(
  node: GraphNode,
  graph: Graph,
  allAspectResults: Record<string, AspectVerificationResult>,
): boolean {
  if (Object.keys(allAspectResults).length > 0) return false;
  const statuses = computeEffectiveAspectStatuses(node, graph);
  for (const s of statuses.values()) {
    if (s !== 'draft') return true;
  }
  return false;
}

/**
 * Merge new verdicts into result.pendingDriftState.
 *
 * When filterAspectId is set (per-aspect approve), only the targeted aspect's
 * verdict is updated — other aspects' prior verdicts are preserved from the
 * stored baseline. When unset (full-node approve), the new verdicts replace the
 * prior set, EXCEPT: (a) when the reviewer aborted before evaluating any aspect
 * (e.g. tier-resolution failure), all prior verdicts are preserved to avoid a
 * "nothing evaluated" wipe; (b) for each aspect in `carryForward` — effective
 * non-draft aspects that could not be validly evaluated this run (infra error or
 * missing result) — the prior verdict is carried forward. Without (b) a transient
 * provider/runner failure on one aspect of a full-node approve would wipe that
 * aspect's known-good baseline verdict, surfacing as aspect-newly-active (a
 * CI-blocking error) on the next check.
 *
 * No-op when result.pendingDriftState is undefined (some early-return paths
 * never set it; baseline simply isn't written, matching prior behavior).
 */
export function applyAspectVerdictsToResult(
  result: ApproveResult,
  verdicts: Record<string, AspectVerdict>,
  carryForward: string[],
  priorVerdicts: Record<string, AspectVerdict> | undefined,
  filterAspectId: string | undefined,
  aborted: boolean,
): void {
  if (!result.pendingDriftState) return;
  let merged: Record<string, AspectVerdict>;
  if (filterAspectId) {
    merged = { ...(priorVerdicts ?? {}), ...verdicts };
  } else if (aborted) {
    merged = { ...(priorVerdicts ?? {}) };
  } else {
    merged = { ...verdicts };
    for (const id of carryForward) {
      const prev = priorVerdicts?.[id];
      if (prev) merged[id] = prev;
    }
  }
  result.pendingDriftState.state.aspectVerdicts = merged;
}

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
  const aspectViolations: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'astRuntime' }> = [];
  const allAspectResults: Record<string, AspectVerificationResult> = {};
  const referencesCache = new Map<string, string>();

  // Every terminal branch funnels through here: record per-aspect verdicts,
  // commit the baseline (evicting stale draft verdicts), and return the result
  // with any branch-specific extras layered on. `skippedDraftAspects` is always
  // attached. Closes over the per-run state above.
  const finalizeAndReturn = async (extras: Partial<LlmApproveResult>): Promise<LlmApproveResult> => {
    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, allAspectResults);
    applyAspectVerdictsToResult(result, verdicts, carryForward, storedEntry?.aspectVerdicts, filterAspectId, reviewerAborted(node, graph, allAspectResults));
    await commitApprovalAndCleanDrafts(rootPath, result, node, graph);
    return { ...result, ...extras, skippedDraftAspects };
  };

  if (filtered.length === 0) {
    return finalizeAndReturn({});
  }

  // No reviewer configured — LLM aspects cannot run; skip and commit
  const hasLlmAspects = filtered.some(a => a.reviewer.type === 'llm');
  if (!graph.config.reviewer && hasLlmAspects) {
    return finalizeAndReturn({ llmSkipped: 'unavailable' });
  }

  // Load source files
  const projectRoot = path.dirname(rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
  const trackedFiles = collectTrackedFiles(node, graph);
  const { fileHashes } = await hashTrackedFiles(projectRoot, trackedFiles, undefined, []);
  const yggPrefix = path.relative(projectRoot, rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
  const sourceFilePaths = Object.keys(fileHashes)
    .map(f => f.replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(f => !f.startsWith(yggPrefix));
  const sourceFiles = await loadSourceFiles(sourceFilePaths, projectRoot);

  const nodeDescription = node.meta.description ?? '';

  // Resolve execution plan
  const plan: ExecutionPlan = graph.config.reviewer
    ? resolveExecutionPlan(filtered, graph.config.reviewer)
    : {
        resolved: filtered
          .filter(a => a.reviewer.type === 'ast' || a.reviewer.type === 'structure')
          .map(a => a.reviewer.type === 'structure'
            ? { kind: 'structure' as const, aspect: a }
            : { kind: 'ast' as const, aspect: a }),
        errors: [],
      };

  if (plan.errors.length > 0) {
    const normalizedNodePath = nodePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const why = plan.errors.map(e => [e.what, e.why].filter(Boolean).join('\n')).join('\n\n');
    return finalizeAndReturn({
      action: 'refused',
      refuseReasonData: {
        what: 'Tier resolution failed for one or more aspects.',
        why,
        next: `Fix the tier configuration in yg-config.yaml and re-run: yg approve --node ${normalizedNodePath}`,
      },
      aspectViolations: [],
    });
  }

  // AST + structure aspects (no LLM call) populate results/violations.
  const astParseCache: ParseCache = new Map();
  await dispatchAstAspects(plan, sourceFiles, projectRoot, astParseCache, allAspectResults, aspectViolations);
  await dispatchStructureAspects(plan, node, graph, result, projectRoot, astParseCache, allAspectResults, aspectViolations);

  // Preserve structureTouchedFiles for structure aspects that were NOT
  // freshly evaluated this run. Two cases collapse into one pass:
  //   - draft-skipped: a structure aspect toggled to draft retains its prior
  //     entry so a later enforced→draft→enforced cycle does not cascade drift.
  //   - filter-excluded: a filtered approve (`yg approve --aspect X`) runs only
  //     X's runner; a neighbor enforced/advisory structure aspect's prior entry
  //     must be carried forward, otherwise its touched files silently drop out
  //     of the node's drift identity and impact blast-radius.
  // An aspect was "freshly evaluated" iff it survived the draft + filter passes
  // (i.e. it is in `filtered`); only those produce a new entry this run.
  if (storedEntry?.structureTouchedFiles && result.pendingDriftState) {
    const stf = result.pendingDriftState.state.structureTouchedFiles ?? {};
    const aspectById = new Map<string, AspectDef>();
    for (const a of allAspects) aspectById.set(a.id, a);
    const freshlyEvaluated = new Set(filtered.map(a => a.id));
    let preserved = 0;
    for (const [id, prior] of Object.entries(storedEntry.structureTouchedFiles)) {
      if (freshlyEvaluated.has(id)) continue; // a fresh entry was produced this run
      if (id in stf) continue;                // already carried (defensive)
      const aspect = aspectById.get(id);
      if (aspect?.reviewer.type !== 'structure') continue;
      stf[id] = prior;
      preserved += 1;
    }
    if (preserved > 0) {
      debugWrite(`[d8.3] preserved structureTouchedFiles for ${preserved} non-evaluated structure aspect(s) on node ${node.path}`);
    }
    result.pendingDriftState.state.structureTouchedFiles = stf;
  }

  // Recompute the canonical drift hash to fold in the structure-touched layer.
  // approveNode computed state.hash BEFORE the structure runner ran, so on a
  // NEW baseline (action initial/approved) the cross-node files just recorded
  // in structureTouchedFiles are not yet part of the node's drift identity.
  // Re-collect WITH the now-populated baseline so collectTrackedFiles emits the
  // structure-touched entries, re-hash, and adopt only the canonical hash —
  // state.files stays the canonical own source/graph map (cross-node paths must
  // NOT enter it; see the touched-files loop above). Skip on no-change/refused:
  // those do not write a fresh baseline.
  if (
    result.pendingDriftState &&
    (result.action === 'initial' || result.action === 'approved') &&
    result.pendingDriftState.state.structureTouchedFiles &&
    Object.keys(result.pendingDriftState.state.structureTouchedFiles).length > 0
  ) {
    const recomputeTracked = collectTrackedFiles(node, graph, result.pendingDriftState.state);
    const recomputeExclusions = getChildMappingExclusions(graph, node.path);
    const { canonicalHash } = await hashTrackedFiles(projectRoot, recomputeTracked, undefined, recomputeExclusions);
    result.pendingDriftState.state.hash = canonicalHash;
    result.currentHash = canonicalHash;
  }

  // AST/structure short-circuit refusal. Refuse early (skipping LLM dispatch)
  // ONLY when something here MUST block: an infrastructure crash (astRuntime)
  // or a code violation of an ENFORCED aspect. If every violation so far is a
  // code violation of an advisory-only aspect, do NOT short-circuit — let the
  // LLM aspects run and let the final status-aware decision below surface the
  // advisory violations without refusing.
  if (aspectViolations.length > 0) {
    const astInfraErrors = aspectViolations.filter(v => v.errorSource !== 'codeViolation');
    const astCodeViolations = aspectViolations.filter(v => v.errorSource === 'codeViolation');
    const { enforced: enforcedAstCode } = partitionCodeViolationsByStatus(astCodeViolations, statuses);
    if (astInfraErrors.length > 0 || enforcedAstCode.length > 0) {
      const normalizedNodePath = nodePath.replace(/\\/g, '/').replace(/\/+$/, '');
      return finalizeAndReturn({
        action: 'refused',
        refuseReasonData: {
          what: 'Reviewer found aspect violations.',
          why: 'One or more aspects were not satisfied by the source code.',
          next: `Fix the violations and re-run: yg approve --node ${normalizedNodePath}`,
        },
        aspectResults: allAspectResults,
        aspectViolations,
      });
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
      // LLM provider unreachable; any violations here are advisory-only code
      // violations from AST/structure (enforced/infra short-circuited above).
      const { advisory: advisoryCodeViolations } =
        partitionCodeViolationsByStatus(aspectViolations.filter(v => v.errorSource === 'codeViolation'), statuses);
      return finalizeAndReturn({
        llmSkipped: 'unavailable',
        aspectResults: allAspectResults,
        advisoryViolations: advisoryCodeViolations.length > 0 ? advisoryCodeViolations : undefined,
      });
    }

    const maxTokens = merged.max_tokens === 'auto'
      ? await resolveMaxTokens(merged, provider)
      : (merged.max_tokens as number);

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
      maxTokens,
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
  const normalizedNodePath = nodePath.replace(/\\/g, '/').replace(/\/+$/, '');

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
    });
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
    });
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
      return finalizeAndReturn({
        action: 'refused',
        refuseReasonData: {
          what: 'Reviewer found aspect violations.',
          why: 'One or more aspects were not satisfied by the source code.',
          next: `Fix the violations and re-run: yg approve --node ${normalizedNodePath}`,
        },
        aspectResults: allAspectResults,
        aspectViolations,
      });
    }

    // Advisory-only code violations: preserve the approved-family action.
    return finalizeAndReturn({
      aspectResults: allAspectResults,
      advisoryViolations: advisoryCodeViolations,
    });
  }

  return finalizeAndReturn({ aspectResults: allAspectResults });
}
