// yg-suppress(deterministic) approve-reviewer must invoke the configured LLM provider for verification; non-determinism is intentional and inherent to this engine's purpose
import type { Graph, AspectDef, LlmConfig, ReviewerConfig } from '../model/graph.js';
import type { ApproveResult, AspectVerificationResult } from '../model/drift.js';
import type { IssueMessage } from '../model/validation.js';
import { verifyAspects } from '../llm/aspect-verifier.js';
import { resolveMaxTokens } from '../llm/api-utils.js';
import { createLlmProvider } from '../llm/index.js';
import { commitApproval, loadSourceFiles } from './approve.js';
import { computeEffectiveAspects } from './graph/aspects.js';
import { collectTrackedFiles } from './graph/files.js';
import { hashTrackedFiles } from '../io/hash.js';
import { selectTierForAspect } from './tier-selection.js';
import { loadSecrets, mergeLlmConfig } from '../io/secrets-parser.js';
import { runAstAspect, AstRunnerError } from '../ast/runner.js';
import { debugWrite } from '../utils/debug-log.js';
import path from 'node:path';

export interface LlmApproveResult extends ApproveResult {
  aspectResults?: Record<string, AspectVerificationResult>;
  llmSkipped?: 'unavailable';
  aspectViolations?: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'astRuntime' }>;
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
}

export async function runApproveWithReviewer(
  input: ApproveWithReviewerInput,
): Promise<LlmApproveResult> {
  const { graph, nodePath, result, rootPath, filterAspectId, secretsByProvider } = input;

  if (result.action === 'refused') return result;

  const node = graph.nodes.get(nodePath);
  if (!node) return result;

  const allAspectIds = computeEffectiveAspects(node, graph);
  const allAspects: AspectDef[] = [...allAspectIds]
    .map((id: string) => graph.aspects.find((a: AspectDef) => a.id === id))
    .filter((a): a is AspectDef => a !== undefined);
  const filtered = filterAspectId
    ? allAspects.filter(a => a.id === filterAspectId)
    : allAspects;

  if (filtered.length === 0) {
    await commitApproval(rootPath, result);
    return { ...result };
  }

  // No reviewer configured — LLM aspects cannot run; skip and commit
  const hasLlmAspects = filtered.some(a => a.reviewer.type !== 'ast');
  if (!graph.config.reviewer && hasLlmAspects) {
    await commitApproval(rootPath, result);
    return { ...result, llmSkipped: 'unavailable' };
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
  const aspectViolations: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'astRuntime' }> = [];
  const allAspectResults: Record<string, AspectVerificationResult> = {};

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
    return {
      ...result,
      action: 'refused',
      refuseReasonData: {
        what: 'Tier resolution failed for one or more aspects.',
        why,
        next: `Fix the tier configuration in yg-config.yaml and re-run: yg approve --node ${normalizedNodePath}`,
      },
      aspectViolations: [],
    };
  }

  // AST aspects first (no LLM call)
  for (const entry of plan.resolved) {
    if (entry.kind !== 'ast') continue;
    const aspect = entry.aspect;
    try {
      const astResult = await runAstAspect({
        aspectDir: path.join('.yggdrasil/aspects', aspect.id),
        aspectId: aspect.id,
        files: sourceFiles.map(f => ({ path: f.path })),
        projectRoot,
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
    };
  }

  // LLM aspects grouped by tier
  type LlmEntry = Extract<ResolvedAspectExecution, { kind: 'llm' }>;
  const llmEntries = plan.resolved.filter((e): e is LlmEntry => e.kind === 'llm');

  if (llmEntries.length === 0) {
    await commitApproval(rootPath, result);
    return { ...result, aspectResults: allAspectResults };
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
      await commitApproval(rootPath, result);
      return { ...result, llmSkipped: 'unavailable', aspectResults: allAspectResults };
    }

    const maxTokens = merged.max_tokens === 'auto'
      ? await resolveMaxTokens(merged, provider)
      : (merged.max_tokens as number);

    const llmResults = await verifyAspects({
      provider,
      aspects: entries.map(e => ({
        id: e.aspect.id,
        description: e.aspect.description ?? e.aspect.name,
        content: aspectContent(e.aspect),
      })),
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

  if (infrastructureErrors.length > 0 && codeViolations.length === 0) {
    return {
      ...result,
      action: 'refused',
      refuseReasonData: {
        what: 'Reviewer infrastructure failed — this is not a code issue.',
        why: 'Provider connection or authentication error, not a code violation.',
        next: 'Check your API key and provider configuration.',
      },
      aspectResults: allAspectResults,
      aspectViolations,
    };
  }

  if (aspectViolations.length > 0) {
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
    };
  }

  await commitApproval(rootPath, result);
  return { ...result, aspectResults: allAspectResults };
}
