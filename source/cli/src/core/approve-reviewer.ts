// yg-suppress(deterministic) approve-reviewer must invoke the configured LLM provider for verification; non-determinism is intentional and inherent to this engine's purpose
import type { Graph, GraphNode, AspectDef, LlmConfig, ReviewerConfig } from '../model/graph.js';
import type { ApproveResult, AspectVerdict, AspectVerificationResult, DriftNodeState } from '../model/drift.js';
import type { IssueMessage } from '../model/validation.js';
import { verifyAspects } from '../llm/aspect-verifier.js';
import { resolveMaxTokens } from '../llm/api-utils.js';
import { createLlmProvider } from '../llm/index.js';
import { commitApproval, loadSourceFiles } from './approve.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from './graph/aspects.js';
import { collectTrackedFiles } from './graph/files.js';
import { hashTrackedFiles } from '../io/hash.js';
import { selectTierForAspect } from './tier-selection.js';
import { loadSecrets, mergeLlmConfig } from '../io/secrets-parser.js';
import { runAstAspect, AstRunnerError } from '../ast/runner.js';
import { debugWrite } from '../utils/debug-log.js';
import { readTextFile } from '../io/graph-fs.js';
import path from 'node:path';

export interface LlmApproveResult extends ApproveResult {
  aspectResults?: Record<string, AspectVerificationResult>;
  llmSkipped?: 'unavailable';
  aspectViolations?: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'astRuntime' }>;
  /** Effective-draft aspects skipped before reviewer dispatch. Empty when none. */
  skippedDraftAspects?: string[];
}

// ── resolveExecutionPlan ─────────────────────────────────────

export type ResolvedAspectExecution =
  | { kind: 'ast'; aspect: AspectDef }
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
    if (aspect.reviewer.type === 'ast') {
      resolved.push({ kind: 'ast', aspect });
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
function buildAspectVerdicts(
  node: GraphNode,
  graph: Graph,
  allAspectResults: Record<string, AspectVerificationResult>,
): Record<string, AspectVerdict> {
  const statuses = computeEffectiveAspectStatuses(node, graph);
  const verdicts: Record<string, AspectVerdict> = {};
  for (const [aspectId, status] of statuses) {
    if (status === 'draft') continue;
    const res = allAspectResults[aspectId];
    if (res?.satisfied === false) {
      verdicts[aspectId] = { verdict: 'refused', reason: res.reason, errorSource: res.errorSource };
    } else if (res?.satisfied === true) {
      verdicts[aspectId] = { verdict: 'approved' };
    }
  }
  return verdicts;
}

/**
 * Merge new verdicts into result.pendingDriftState.
 *
 * When filterAspectId is set (per-aspect approve), only the targeted aspect's
 * verdict is updated — other aspects' prior verdicts are preserved from the
 * stored baseline. When unset (full-node approve), the new verdicts fully
 * replace the prior set.
 *
 * No-op when result.pendingDriftState is undefined (some early-return paths
 * never set it; baseline simply isn't written, matching prior behavior).
 */
function applyAspectVerdictsToResult(
  result: ApproveResult,
  verdicts: Record<string, AspectVerdict>,
  priorVerdicts: Record<string, AspectVerdict> | undefined,
  filterAspectId: string | undefined,
): void {
  if (!result.pendingDriftState) return;
  const merged: Record<string, AspectVerdict> = filterAspectId
    ? { ...(priorVerdicts ?? {}), ...verdicts }
    : verdicts;
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
}

export async function runApproveWithReviewer(
  input: ApproveWithReviewerInput,
): Promise<LlmApproveResult> {
  const { graph, nodePath, result, rootPath, filterAspectId, secretsByProvider, storedEntry } = input;

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

  const filtered = filterAspectId
    ? nonDraft.filter(a => a.id === filterAspectId)
    : nonDraft;

  // Hoisted: needed by buildAspectVerdicts in early-return paths below.
  const aspectViolations: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'astRuntime' }> = [];
  const allAspectResults: Record<string, AspectVerificationResult> = {};
  const referencesCache = new Map<string, string>();

  if (filtered.length === 0) {
    const verdicts = buildAspectVerdicts(node, graph, allAspectResults);
    applyAspectVerdictsToResult(result, verdicts, storedEntry?.aspectVerdicts, filterAspectId);
    await commitApproval(rootPath, result);
    return { ...result, skippedDraftAspects };
  }

  // No reviewer configured — LLM aspects cannot run; skip and commit
  const hasLlmAspects = filtered.some(a => a.reviewer.type !== 'ast');
  if (!graph.config.reviewer && hasLlmAspects) {
    const verdicts = buildAspectVerdicts(node, graph, allAspectResults);
    applyAspectVerdictsToResult(result, verdicts, storedEntry?.aspectVerdicts, filterAspectId);
    await commitApproval(rootPath, result);
    return { ...result, llmSkipped: 'unavailable', skippedDraftAspects };
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
        resolved: filtered.filter(a => a.reviewer.type === 'ast').map(a => ({ kind: 'ast' as const, aspect: a })),
        errors: [],
      };

  if (plan.errors.length > 0) {
    const normalizedNodePath = nodePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const why = plan.errors.map(e => [e.what, e.why].filter(Boolean).join('\n')).join('\n\n');
    const verdicts = buildAspectVerdicts(node, graph, allAspectResults);
    applyAspectVerdictsToResult(result, verdicts, storedEntry?.aspectVerdicts, filterAspectId);
    await commitApproval(rootPath, result);
    return {
      ...result,
      action: 'refused',
      refuseReasonData: {
        what: 'Tier resolution failed for one or more aspects.',
        why,
        next: `Fix the tier configuration in yg-config.yaml and re-run: yg approve --node ${normalizedNodePath}`,
      },
      aspectViolations: [],
      skippedDraftAspects,
    };
  }

  // AST aspects first (no LLM call)
  const astParseCache = new Map();
  for (const entry of plan.resolved) {
    if (entry.kind !== 'ast') continue;
    const aspect = entry.aspect;
    try {
      const astResult = await runAstAspect({
        aspectDir: path.join('.yggdrasil/aspects', aspect.id),
        aspectId: aspect.id,
        files: sourceFiles.map(f => ({ path: f.path })),
        projectRoot,
        parseCache: astParseCache,
      });
      const violated = astResult.violations.length > 0;
      const reason = violated
        ? astResult.violations.map(v => `${v.file}:${v.line}: ${v.message}`).join('\n')
        : 'all rules satisfied';
      allAspectResults[aspect.id] = { satisfied: !violated, reason, errorSource: 'codeViolation' };
      if (violated) {
        aspectViolations.push({ aspectId: aspect.id, reason, errorSource: 'codeViolation' });
      }
    } catch (e: unknown) {
      debugWrite(`[approve] ast aspect ${aspect.id}: ${e instanceof Error ? e.message : String(e)}`);
      const code: string = (e as { code?: string }).code ?? 'AST_RUNNER_UNKNOWN';
      const rendered = e instanceof AstRunnerError
        ? `${e.messageData.what} — ${e.messageData.why}`
        : (e as Error).message;
      const reason = `[${code}] ${rendered}`;
      allAspectResults[aspect.id] = { satisfied: false, reason, errorSource: 'astRuntime' };
      aspectViolations.push({ aspectId: aspect.id, reason, errorSource: 'astRuntime' });
    }
  }

  if (aspectViolations.length > 0) {
    const normalizedNodePath = nodePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const verdicts = buildAspectVerdicts(node, graph, allAspectResults);
    applyAspectVerdictsToResult(result, verdicts, storedEntry?.aspectVerdicts, filterAspectId);
    await commitApproval(rootPath, result);
    return {
      ...result,
      action: 'refused',
      refuseReasonData: {
        what: 'Reviewer found aspect violations.',
        why: 'One or more aspects were not satisfied by the source code.',
        next: `Fix the violations and re-run: yg approve --node ${normalizedNodePath}`,
      },
      aspectResults: allAspectResults,
      aspectViolations,
      skippedDraftAspects,
    };
  }

  // LLM aspects grouped by tier
  type LlmEntry = Extract<ResolvedAspectExecution, { kind: 'llm' }>;
  const llmEntries = plan.resolved.filter((e): e is LlmEntry => e.kind === 'llm');

  if (llmEntries.length === 0) {
    const verdicts = buildAspectVerdicts(node, graph, allAspectResults);
    applyAspectVerdictsToResult(result, verdicts, storedEntry?.aspectVerdicts, filterAspectId);
    await commitApproval(rootPath, result);
    return { ...result, aspectResults: allAspectResults, skippedDraftAspects };
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
      const verdicts = buildAspectVerdicts(node, graph, allAspectResults);
      applyAspectVerdictsToResult(result, verdicts, storedEntry?.aspectVerdicts, filterAspectId);
      await commitApproval(rootPath, result);
      return { ...result, llmSkipped: 'unavailable', aspectResults: allAspectResults, skippedDraftAspects };
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
    const verdicts = buildAspectVerdicts(node, graph, allAspectResults);
    applyAspectVerdictsToResult(result, verdicts, storedEntry?.aspectVerdicts, filterAspectId);
    await commitApproval(rootPath, result);
    return {
      ...result,
      action: 'refused',
      refuseReasonData: {
        what: `Reference file load failed for ${referenceFailures.length} aspect(s): ${referenceFailures.map(f => f.aspectId).join(', ')}.`,
        why: 'one or more aspects declare references that could not be read at approve time. Earlier failures are listed above with the file path and syscall reason.',
        next: `restore the missing reference file(s), fix the path in the aspect yg-aspect.yaml, or remove the reference. Then re-run: yg approve --node ${normalizedNodePath}`,
      },
      aspectResults: allAspectResults,
      aspectViolations,
      skippedDraftAspects,
    };
  }

  if (infrastructureErrors.length > 0 && codeViolations.length === 0) {
    const verdicts = buildAspectVerdicts(node, graph, allAspectResults);
    applyAspectVerdictsToResult(result, verdicts, storedEntry?.aspectVerdicts, filterAspectId);
    await commitApproval(rootPath, result);
    return {
      ...result,
      action: 'refused',
      refuseReasonData: {
        what: 'Reviewer infrastructure failed — this is not a code issue.',
        why: 'provider connection or authentication error, not a code violation.',
        next: 'Check your API key and provider configuration.',
      },
      aspectResults: allAspectResults,
      aspectViolations,
      skippedDraftAspects,
    };
  }

  if (aspectViolations.length > 0) {
    const verdicts = buildAspectVerdicts(node, graph, allAspectResults);
    applyAspectVerdictsToResult(result, verdicts, storedEntry?.aspectVerdicts, filterAspectId);
    await commitApproval(rootPath, result);
    return {
      ...result,
      action: 'refused',
      refuseReasonData: {
        what: 'Reviewer found aspect violations.',
        why: 'One or more aspects were not satisfied by the source code.',
        next: `Fix the violations and re-run: yg approve --node ${normalizedNodePath}`,
      },
      aspectResults: allAspectResults,
      aspectViolations,
      skippedDraftAspects,
    };
  }

  const verdicts = buildAspectVerdicts(node, graph, allAspectResults);
  applyAspectVerdictsToResult(result, verdicts, storedEntry?.aspectVerdicts, filterAspectId);
  await commitApproval(rootPath, result);
  return { ...result, aspectResults: allAspectResults, skippedDraftAspects };
}
