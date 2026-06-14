/**
 * source/cli/src/core/fill-llm.ts — the LLM-pair filler for the fill stage (spec
 * §7 step 6). Loads subject + reference bytes byte-identically to the verifier,
 * assembles the prompt, runs the tier's consensus votes, and on a real verdict
 * produces the content-addressed entry. Every infra disposition (reference
 * unreadable, provider error/unparseable) returns { kind: 'infra' } so the caller
 * writes NOTHING (spec §3.2).
 *
 * yg-suppress(deterministic) the fill stage exists to invoke the configured LLM reviewer; non-determinism is inherent to its purpose, and every verdict it records is content-addressed so reproducibility is enforced at the lock layer instead
 */

import path from 'node:path';

import type { Graph, AspectDef, LlmConfig } from '../model/graph.js';
import type { VerdictEntry, Verdict } from '../model/lock.js';
import type { ExpectedPair } from './pairs.js';
import { computeLlmInputHash } from './pair-hash.js';
import { ruleHashFor, contentFor, nodeDescriptionFor, tierHashViewFromTier } from './pair-inputs.js';
import { hashBytes } from '../io/hash.js';
import { buildPairPrompt } from '../llm/prompt.js';
import type { PromptReferenceInput, PromptFileInput } from '../llm/prompt.js';
import { verifyWithConsensus } from '../llm/aspect-verifier.js';
import type { LlmProvider } from '../llm/types.js';
import { readFileBytes } from '../io/graph-fs.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import { readBytesOrEmpty, type LlmFillOutcome } from './fill-shared.js';

/**
 * Fill one LLM pair: load references (a MISSING reference is a LOUD infra
 * failure — contract #6, never empty-bytes hashing), assemble the prompt, run
 * the tier's consensus votes, and on a real verdict compute the hash + entry.
 * Every infra disposition (reference unreadable, provider error/unparseable)
 * returns { kind: 'infra' } so the caller writes NOTHING.
 */
export async function fillLlmPair(
  graph: Graph,
  projectRoot: string,
  pair: ExpectedPair,
  aspect: AspectDef,
  tier: LlmConfig,
  tierName: string,
  mergedTier: LlmConfig,
  provider: LlmProvider,
  referencesCache: Map<string, Buffer | null>,
): Promise<LlmFillOutcome> {
  // ── Load subject file bytes (sorted by path is the pair's contract). ──
  const subjects: Array<{ path: string; bytes: Buffer }> = [];
  for (const rel of pair.subjectFiles) {
    const bytes = await readBytesOrEmpty(path.resolve(projectRoot, rel));
    subjects.push({ path: rel, bytes });
  }

  // ── Load references as RAW disk bytes — byte-identical to the verifier
  // (verify-lock.ts reads each reference via readFileBytes and folds those raw
  // bytes; the prompt content there is rawBytes.toString('utf8')). Hashing,
  // prompting, and the §4 size gate must all be measured over the SAME bytes, so
  // a reference carrying a UTF-8 BOM or an invalid byte cannot make the producer
  // and verifier disagree (which would pin the verdict to a permanent false-red).
  // A missing reference stays a LOUD infra failure (#6) — never hashed over
  // empty-substituted bytes. ──
  const refInputs = aspect.references ?? [];
  const referencesForHash: Array<[string, string, string]> = [];
  const referencesForPrompt: PromptReferenceInput[] = [];
  for (const ref of refInputs) {
    const absRef = path.resolve(projectRoot, ref.path);
    let bytes = referencesCache.get(absRef);
    if (bytes === undefined) {
      bytes = await readFileBytes(absRef); // raw disk Buffer, no decode, no BOM strip; null on error
      if (bytes === null) {
        debugWrite(`[fill] reference load failed for ${aspect.id} path ${toPosixPath(ref.path)}`);
      }
      referencesCache.set(absRef, bytes);
    }
    if (bytes === null) {
      // Never hash over empty-substituted bytes — fail closed.
      const why = `reference '${toPosixPath(ref.path)}' for aspect '${aspect.id}' could not be read`;
      return {
        kind: 'infra',
        why,
        messageData: {
          what: `Reference file '${toPosixPath(ref.path)}' for aspect '${aspect.id}' could not be read.`,
          why: 'A declared reference is part of the verifier input; reading empty-substituted bytes would desync the producer and verifier and pin a false verdict, so the fill fails closed and writes NOTHING.',
          next: `Restore the reference file at '${toPosixPath(ref.path)}' or fix its permissions, then re-run: yg check --approve`,
        },
        callsMade: 0,
      };
    }
    referencesForHash.push([ref.path, hashBytes(bytes), ref.description ?? '']);
    referencesForPrompt.push({ path: ref.path, description: ref.description, content: bytes.toString('utf8') });
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
    const detail = e instanceof Error ? e.message : String(e);
    debugWrite(`[fill] reviewer threw for ${aspect.id} on ${pair.unitKey}: ${detail}`);
    return {
      kind: 'infra',
      why: `the reviewer threw or returned an unparseable response: ${detail}`,
      messageData: {
        what: `Reviewer for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} threw or returned an unparseable response: ${detail}`,
        why: 'The reviewer could not produce a verdict — an infrastructure problem, not a code violation. Fail-closed: NOTHING was written, the pair stays unverified (spec §3.2).',
        next: 'Check the provider endpoint, network, and credentials, then re-run: yg check --approve',
      },
      callsMade: consensus,
    };
  }

  // A provider-sourced failure is infra (no write). Only a codeViolation maps to
  // a real verdict token.
  if (!response.satisfied && response.errorSource === 'provider') {
    return {
      kind: 'infra',
      why: `the reviewer returned a provider error: ${response.reason}`,
      messageData: {
        what: `Reviewer for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} returned a provider error: ${response.reason}`,
        why: 'A provider-sourced failure is infrastructure, not a code violation — only a codeViolation maps to a real verdict. Fail-closed: NOTHING was written, the pair stays unverified (spec §3.2).',
        next: 'Check the provider endpoint, network, and credentials, then re-run: yg check --approve',
      },
      callsMade: consensus,
    };
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
