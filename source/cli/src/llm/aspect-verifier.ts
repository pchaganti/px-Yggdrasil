import type { LlmProvider, AspectResponse } from './types.js';
import type { AspectVerificationResult } from '../model/drift.js';
import { buildPairPrompt } from './prompt.js';

export type { PromptAspectInput, PromptReferenceInput, PromptFileInput, PairPromptInput } from './prompt.js';
export { buildPairPrompt, assembledPromptChars } from './prompt.js';

export interface VerifyAspectsParams {
  provider: LlmProvider;
  aspects: Array<{
    id: string;
    description: string;
    content: string;
    references?: Array<{ path: string; description?: string; content: string }>;
  }>;
  sourceFiles: Array<{ path: string; content: string }>;
  nodeDescription: string;
  nodePath: string;
  consensus?: number;
}

export function buildPrompt(
  aspect: { id: string; description: string; content: string },
  nodeDescription: string,
  nodePath: string,
  sourceFiles: Array<{ path: string; content: string }>,
  references: Array<{ path: string; description?: string; content: string }> = [],
): string {
  return buildPairPrompt({
    aspect,
    nodeDescription,
    nodePath,
    files: sourceFiles,
    references,
    scope: undefined,
  });
}


async function verifyWithConsensus(
  provider: LlmProvider,
  prompt: string,
  consensus: number,
): Promise<AspectResponse> {
  if (consensus <= 1) {
    return provider.verifyAspect(prompt);
  }

  const votes: AspectResponse[] = [];
  for (let i = 0; i < consensus; i++) {
    votes.push(await provider.verifyAspect(prompt));
  }

  const satisfied = votes.filter(v => v.satisfied).length;
  const notSatisfied = votes.filter(v => !v.satisfied).length;

  if (satisfied > notSatisfied) {
    return { satisfied: true, reason: votes.find(v => v.satisfied)!.reason, errorSource: 'codeViolation' };
  }
  const losingVotes = votes.filter(v => !v.satisfied);
  const allProvider = losingVotes.every(v => v.errorSource === 'provider');
  return {
    satisfied: false,
    reason: losingVotes[0]!.reason,
    errorSource: allProvider ? 'provider' : 'codeViolation',
  };
}

export async function verifyAspects(
  params: VerifyAspectsParams,
): Promise<Record<string, AspectVerificationResult>> {
  const { provider, aspects, sourceFiles, nodePath, nodeDescription, consensus = 1 } = params;
  const results: Record<string, AspectVerificationResult> = {};
  for (const aspect of aspects) {
    const prompt = buildPrompt(aspect, nodeDescription, nodePath, sourceFiles, aspect.references ?? []);
    const r = await verifyWithConsensus(provider, prompt, consensus);
    results[aspect.id] = { satisfied: r.satisfied, reason: r.reason, errorSource: r.errorSource };
  }
  return results;
}
