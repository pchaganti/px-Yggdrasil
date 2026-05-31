import type { LlmProvider, AspectResponse } from './types.js';
import type { AspectVerificationResult } from '../model/drift.js';
import { escapeXmlText } from './xml-escape.js';

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
  maxTokens?: number;
}

export function buildPrompt(
  aspect: { id: string; description: string; content: string },
  nodeDescription: string,
  nodePath: string,
  sourceFiles: Array<{ path: string; content: string }>,
  references: Array<{ path: string; description?: string; content: string }> = [],
): string {
  // Escape adopter-controlled interpolations so source content cannot break out
  // of the XML framing or inject markup into the reviewer prompt — matching the
  // references block, which is already escaped. The `path` is an attribute; the
  // file body is text. (The aspect rule body below stays raw: it is the trusted
  // instruction the reviewer must read verbatim.)
  const files = sourceFiles.map(f =>
    `<file path="${escapeXmlText(f.path, { attribute: true })}">\n${escapeXmlText(f.content, { attribute: false })}\n</file>`
  ).join('\n\n');

  const referencesBlock = references.length === 0 ? '' : `

<references>
${references.map(r => {
  const descAttr = r.description ? ` description="${escapeXmlText(r.description, { attribute: true })}"` : '';
  return `  <reference path="${escapeXmlText(r.path, { attribute: true })}"${descAttr}>
${escapeXmlText(r.content, { attribute: false })}
  </reference>`;
}).join('\n')}
</references>`;

  return `<task>
You verify whether source code satisfies a requirement.

Below is a node (component) with its source files and one aspect (rule set).
Check every rule in the aspect against the source code.

If source code contains a comment with the marker yg-suppress(<aspect-id>) where
<aspect-id> matches the aspect you are checking, treat the suppressed code as satisfied.
The marker must include a reason after the closing parenthesis. Do not validate the
reason — accept it as-is. The marker applies contextually to the surrounding code
(function, class, or block where it appears). If placed at file level, it applies to
the entire file.

A bracket form also exists: yg-suppress-disable(<aspect-id>) <reason> placed before a
block, and yg-suppress-enable(<aspect-id>) placed after it, suppresses all code between
the two markers. Honor the bracket form the same way as the single-line form.

Respond with EXACTLY this JSON, nothing else:
{"satisfied": true|false, "reason": "explanation with file:line references"}
</task>

<node path="${escapeXmlText(nodePath, { attribute: true })}" description="${escapeXmlText(nodeDescription, { attribute: true })}" />

<aspect id="${escapeXmlText(aspect.id, { attribute: true })}" description="${escapeXmlText(aspect.description, { attribute: true })}">
${aspect.content}
</aspect>${referencesBlock}

<source-files>
${files}
</source-files>`;
}

export function chunkSourceFiles(
  files: Array<{ path: string; content: string }>,
  maxTokens: number,
): Array<Array<{ path: string; content: string }>> {
  const overhead = 500;
  const effectiveMax = Math.max(maxTokens, 1000);
  const available = (effectiveMax - overhead) * 4;
  const chunks: Array<Array<{ path: string; content: string }>> = [];
  let current: Array<{ path: string; content: string }> = [];
  let currentSize = 0;

  for (const file of files) {
    const fileSize = file.path.length + file.content.length + 30;
    if (fileSize > available) {
      const truncated = file.content.slice(0, available);
      chunks.push([{ path: file.path, content: truncated + '\n[... truncated]' }]);
      continue;
    }
    if (currentSize + fileSize > available && current.length > 0) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(file);
    currentSize += fileSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [[]];
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
  const { provider, aspects, sourceFiles, nodePath, nodeDescription, consensus = 1, maxTokens } = params;

  if (sourceFiles.length === 0) {
    return Object.fromEntries(aspects.map(a => [a.id, { satisfied: true, reason: 'No source files', errorSource: 'codeViolation' as const }]));
  }

  const tokenBudget = maxTokens ?? 8192;
  const chunks = chunkSourceFiles(sourceFiles, tokenBudget);
  const results: Record<string, AspectVerificationResult> = {};

  for (const aspect of aspects) {
    let failed = false;
    let failReason = '';
    let failErrorSource: AspectResponse['errorSource'] = 'codeViolation';

    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const prompt = buildPrompt(aspect, nodeDescription, nodePath, chunk, aspect.references ?? []);
      const result = await verifyWithConsensus(provider, prompt, consensus);
      if (!result.satisfied) {
        failed = true;
        failReason = result.reason;
        failErrorSource = result.errorSource;
        break;
      }
    }

    results[aspect.id] = failed
      ? { satisfied: false, reason: failReason, errorSource: failErrorSource }
      : { satisfied: true, reason: `All rules satisfied across ${chunks.length} file group(s)`, errorSource: 'codeViolation' };
  }

  return results;
}
