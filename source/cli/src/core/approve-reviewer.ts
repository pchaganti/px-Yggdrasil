// yg-suppress(deterministic) approve-reviewer must invoke the configured LLM provider for verification; non-determinism is intentional and inherent to this engine's purpose
import type { Graph } from '../model/graph.js';
import type { ApproveResult, AspectVerificationResult } from '../model/drift.js';
import type { LlmProvider } from '../llm/types.js';
import type { IssueMessage } from '../model/validation.js';
import { verifyAspects } from '../llm/aspect-verifier.js';
import { resolveMaxTokens } from '../llm/api-utils.js';
import { commitApproval, resolveAspects, loadSourceFiles } from './approve.js';
import { collectTrackedFiles } from './graph/files.js';
import { hashTrackedFiles } from '../io/hash.js';
import path from 'node:path';

export interface LlmApproveResult extends ApproveResult {
  aspectResults?: Record<string, AspectVerificationResult>;
  llmSkipped?: 'unavailable';
  aspectViolations?: Array<{ aspectId: string; reason: string; providerError?: boolean }>;
}

export interface ApproveWithReviewerInput {
  graph: Graph;
  nodePath: string;
  result: ApproveResult;
  provider: LlmProvider;
  maxTokens: number | undefined;
  consensus: number | undefined;
  filterAspectId?: string;
}

export async function runApproveWithReviewer(
  input: ApproveWithReviewerInput,
): Promise<LlmApproveResult> {
  const { graph, nodePath, result, provider, maxTokens, consensus, filterAspectId } = input;

  if (result.action === 'refused') return result;

  const node = graph.nodes.get(nodePath);
  if (!node) return result;

  const allLlmAspects = resolveAspects(node, graph).filter(a => a.reviewer !== 'ast');
  const llmAspects = filterAspectId
    ? allLlmAspects.filter(a => a.id === filterAspectId)
    : allLlmAspects;

  if (llmAspects.length === 0) {
    await commitApproval(graph.rootPath, result);
    return { ...result };
  }

  const projectRoot = path.dirname(graph.rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
  const trackedFiles = collectTrackedFiles(node, graph);
  const { fileHashes } = await hashTrackedFiles(projectRoot, trackedFiles, undefined, []);
  const yggPrefix = path.relative(projectRoot, graph.rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
  const sourceFilePaths = Object.keys(fileHashes)
    .map(f => f.replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(f => !f.startsWith(yggPrefix));
  const sourceFiles = await loadSourceFiles(sourceFilePaths, projectRoot);

  const nodeDescription = node.meta.description ?? '';
  const llmCfg = graph.config.llm ?? { provider: 'ollama' as const, model: '', temperature: 0, consensus: 1, max_tokens: 'auto' as const };
  const resolvedMaxTokens = maxTokens ?? await resolveMaxTokens(llmCfg, provider);

  const llmResults = await verifyAspects({
    provider,
    aspects: llmAspects,
    sourceFiles,
    nodePath,
    nodeDescription,
    consensus: consensus ?? 1,
    maxTokens: resolvedMaxTokens,
  });

  const aspectViolations: Array<{ aspectId: string; reason: string; providerError?: boolean }> = [];
  for (const [aspectId, res] of Object.entries(llmResults)) {
    if (!res.satisfied) {
      const isProviderError = res.errorSource === 'provider' || res.errorSource === 'astRuntime';
      aspectViolations.push({ aspectId, reason: res.reason, providerError: isProviderError });
    }
  }

  const providerErrors = aspectViolations.filter(v => v.providerError);
  const codeViolations = aspectViolations.filter(v => !v.providerError);

  if (providerErrors.length > 0 && codeViolations.length === 0) {
    const refuseMsg: IssueMessage = {
      what: 'Reviewer provider failed — this is not a code issue.',
      why: 'Provider connection or authentication error, not a code violation.',
      next: 'Check your API key and provider configuration.',
    };
    return {
      ...result,
      action: 'refused',
      refuseReasonData: refuseMsg,
      aspectResults: llmResults,
      aspectViolations,
    };
  }

  if (aspectViolations.length > 0) {
    const refuseMsg: IssueMessage = {
      what: 'Reviewer found aspect violations.',
      why: 'One or more aspects were not satisfied by the source code.',
      next: `Fix the violations and re-run: yg approve --node ${nodePath}`,
    };
    return {
      ...result,
      action: 'refused',
      refuseReasonData: refuseMsg,
      aspectResults: llmResults,
      aspectViolations,
    };
  }

  await commitApproval(graph.rootPath, result);
  return { ...result, aspectResults: llmResults };
}
