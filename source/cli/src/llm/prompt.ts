// Reviewer prompt assembly — per-node and per-file scaffold variants.
import type { ScopeDef } from '../model/graph.js';
import { escapeXmlText } from './xml-escape.js';

export interface PromptAspectInput { id: string; description: string; content: string }
export interface PromptReferenceInput { path: string; description?: string; content: string }
export interface PromptFileInput { path: string; content: string }
export interface PromptCompanionInput { path: string; content: string; label?: string }
export interface PairPromptInput {
  aspect: PromptAspectInput;
  references: PromptReferenceInput[];
  nodePath: string;
  nodeDescription: string;
  files: PromptFileInput[];           // per-node: whole subject set; per-file: exactly one
  companions?: PromptCompanionInput[];   // resolved per-unit by companion.mjs; absent for plain aspects
  scope: ScopeDef | undefined;        // undefined ≙ {per:'node'}
}

/** The single-file framing sentence added when scope.per === 'file'. */
const PER_FILE_FRAMING =
  `You are reviewing ONE file of a larger component. Other files of the component are not shown; the absence of sibling context is NOT a violation by itself. Judge only what this file must satisfy on its own.`;

/**
 * Assembles the reviewer prompt. Per-node output is BYTE-IDENTICAL to the legacy
 * buildPrompt for equivalent inputs (golden-pinned). Per-file adds the single-file framing.
 *
 * Contract for callers: with scope.per === 'file', callers MUST pass exactly one file in
 * `input.files`. Passing multiple files would contradict the single-file framing sentence
 * added by this function — the reviewer would see "you are reviewing ONE file" while
 * receiving several. Enforcing this constraint is the caller's responsibility.
 */
export function buildPairPrompt(input: PairPromptInput): string {
  const { aspect, references, nodePath, nodeDescription, files, companions, scope } = input;

  const isPerFile = scope?.per === 'file';

  // Escape adopter-controlled interpolations so source content cannot break out
  // of the XML framing or inject markup into the reviewer prompt — matching the
  // references block, which is already escaped. The `path` is an attribute; the
  // file body is text. (The aspect rule body below stays raw: it is the trusted
  // instruction the reviewer must read verbatim.)
  const filesBlock = files.map(f =>
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

  const sortedCompanions = [...(companions ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const companionsBlock = sortedCompanions.length === 0 ? '' : `

These are the subject's resolved paired file(s) — read-only context, not the unit under judgment:
<companions>
${sortedCompanions.map(c => {
  const labelAttr = c.label ? ` label="${escapeXmlText(c.label, { attribute: true })}"` : '';
  return `  <companion path="${escapeXmlText(c.path, { attribute: true })}"${labelAttr}>
${escapeXmlText(c.content, { attribute: false })}
  </companion>`;
}).join('\n')}
</companions>`;

  const perFileParagraph = isPerFile ? `\n${PER_FILE_FRAMING}\n` : '';

  return `<task>
You verify whether source code satisfies a requirement.

Below is a node (component) with its source files and one aspect (rule set).
Check every rule in the aspect against the source code.

If a file in <source-files> below contains a comment with the marker yg-suppress(<aspect-id>) where
<aspect-id> matches the aspect you are checking, treat the suppressed code as satisfied.
The marker must include a reason after the closing parenthesis. Do not validate the
reason — accept it as-is. The marker applies contextually to the surrounding code
(function, class, or block where it appears). If placed at file level, it applies to
the entire file.

A bracket form also exists: yg-suppress-disable(<aspect-id>) <reason> placed before a
block in <source-files>, and yg-suppress-enable(<aspect-id>) placed after it, suppresses all code between
the two markers. Honor the bracket form the same way as the single-line form.
${perFileParagraph}
Respond with EXACTLY this JSON, nothing else:
{"satisfied": true|false, "reason": "explanation with file:line references"}
</task>

<node path="${escapeXmlText(nodePath, { attribute: true })}" description="${escapeXmlText(nodeDescription, { attribute: true })}" />

<aspect id="${escapeXmlText(aspect.id, { attribute: true })}" description="${escapeXmlText(aspect.description, { attribute: true })}">
${aspect.content}
</aspect>${referencesBlock}${companionsBlock}

<source-files>
${filesBlock}
</source-files>`;
}

/** Gate-canonical prompt: companions rendered WITHOUT labels (verify cannot reconstruct labels). The §4 gate measures THIS. */
export function assembledPromptChars(input: PairPromptInput): number {
  const gateCompanions = (input.companions ?? []).map((c) => ({ path: c.path, content: c.content }));
  return buildPairPrompt({ ...input, companions: gateCompanions }).length;
}
