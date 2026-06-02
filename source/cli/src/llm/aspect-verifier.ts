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
