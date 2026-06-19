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
import { ruleHashFor, contentFor, nodeDescriptionFor, tierHashViewFromTier, companionHashFor } from './pair-inputs.js';
import { computeNodeMappedFiles } from './pairs.js';
import { hashBytes } from '../io/hash.js';
import { buildPairPrompt, assembledPromptChars } from '../llm/prompt.js';
import type { PromptReferenceInput, PromptFileInput, PromptCompanionInput } from '../llm/prompt.js';
import { verifyWithConsensus } from '../llm/aspect-verifier.js';
import type { LlmProvider } from '../llm/types.js';
import { readFileBytes } from '../io/graph-fs.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import { runCompanionHook } from '../structure/hook-loader.js';
import type { IssueMessage } from '../model/validation.js';
import { resolveCompanionDescriptors } from './companion-resolve.js';
import { readBytesOrEmpty, type LlmFillOutcome } from './fill-shared.js';

/**
 * The resolved per-unit companion set: the read-only paired files (paths +
 * content) for the prompt, and the read: observations that fold into the LLM pair
 * hash so an edit to a companion file invalidates the verdict.
 */
interface ResolvedCompanions {
  promptCompanions: PromptCompanionInput[];
  /** [observationKey, observationHash] — the union of the hook's own out-of-subject
   *  observations AND a read: observation per companion file fill-llm reads itself.
   *  Sorted + deduped (the hash sorts but does not dedupe). */
  observations: Array<[string, string]>;
}

/**
 * Resolve an aspect's companion.mjs over the unit, BEFORE consensus. The whole
 * resolution fails closed: a torn observation set (tainted twice), a hook throw,
 * a bad shape, a missing path, or a path outside allowed-reads returns
 * { kind: 'infra', callsMade: 0 } — NOTHING is written and the reviewer is never
 * called (a torn observation set must never cost a reviewer call). Mirrors the
 * fill-det A6 taint guard (run once → retry once → still tainted → infra).
 */
async function resolveCompanions(
  graph: Graph,
  projectRoot: string,
  pair: ExpectedPair,
  aspect: AspectDef,
): Promise<{ kind: 'ok'; companions: ResolvedCompanions } | { kind: 'infra'; why: string; messageData: IssueMessage }> {
  const aspectDirAbs = path.join(projectRoot, '.yggdrasil', 'aspects', aspect.id);

  // subjectScope mirrors fill-det: narrow iff the subject set is FEWER files than
  // the node's full mapping (per:file, or per:node with a scope.files filter). A
  // plain per:node aspect has subject == full mapping → undefined (legacy ctx).
  const fullMapping = await computeNodeMappedFiles(graph, pair.nodePath);
  const subjectScope = pair.subjectFiles.length < fullMapping.length ? pair.subjectFiles : undefined;

  const runOnce = (): ReturnType<typeof runCompanionHook> =>
    runCompanionHook({
      aspectDir: aspectDirAbs,
      aspectId: aspect.id,
      nodePath: pair.nodePath,
      graph,
      projectRoot,
      subjectScope,
    });

  // A6 taint guard: run once; a tainted set re-runs once; still tainted → infra.
  let run = await runOnce();
  if (run.kind === 'infra') {
    return { kind: 'infra', why: `companion resolution failed: ${run.messageData.what}`, messageData: run.messageData };
  }
  if (run.observationsTainted) {
    run = await runOnce();
    if (run.kind === 'infra') {
      return { kind: 'infra', why: `companion resolution failed: ${run.messageData.what}`, messageData: run.messageData };
    }
    if (run.observationsTainted) {
      const what = `Companion resolution for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} produced an inconsistent observation set across two runs.`;
      const why = 'companion observations remained inconsistent across two runs (a file changed mid-resolution); a torn set cannot be hashed, so the fill fails closed and writes NOTHING — never paying the reviewer over a torn observation set.';
      const next = 'Re-run once the working tree is stable: yg check --approve';
      return { kind: 'infra', why: 'companion observations remained inconsistent across two runs', messageData: { what, why, next } };
    }
  }

  // ── Delegate post-hook resolution to the shared helper (normalize, dedupe,
  // sort, allowed-reads guard, readFileBytes, observations merge). ──
  const resolved = await resolveCompanionDescriptors(graph, projectRoot, pair, aspect, run.descriptors, run.observations);
  if (resolved.kind === 'infra') {
    return { kind: 'infra', why: resolved.why, messageData: resolved.messageData };
  }
  return { kind: 'ok', companions: { promptCompanions: resolved.companions, observations: resolved.observations } };
}

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

  // ── Resolve companions BEFORE consensus (spec: a torn observation set must
  // NEVER cost a reviewer call). The plain path (no companion.mjs) skips this
  // entirely so its behavior is byte-identical to the pre-companion contract;
  // companionHash is then undefined and the hash is unchanged. ──
  let companions: PromptCompanionInput[] = [];
  let observations: Array<[string, string]> = [];
  if (aspect.hasCompanion === true) {
    const resolved = await resolveCompanions(graph, projectRoot, pair, aspect);
    if (resolved.kind === 'infra') {
      // Fail closed — NOTHING written, the reviewer is never called (callsMade: 0).
      debugWrite(`[fill] companion resolution failed for ${aspect.id} on ${pair.unitKey}: ${resolved.messageData.what}`);
      return { kind: 'infra', why: resolved.why, messageData: resolved.messageData, callsMade: 0 };
    }
    companions = resolved.companions.promptCompanions;
    observations = resolved.companions.observations;
  }

  const promptInput = {
    aspect: { id: aspect.id, description: aspect.description ?? '', content: contentFor(aspect, 'content.md') },
    references: referencesForPrompt,
    nodePath: pair.nodePath,
    nodeDescription: nodeDescriptionFor(graph, pair.nodePath),
    files: subjects.map<PromptFileInput>((s) => ({ path: s.path, content: s.bytes.toString('utf8') })),
    companions,
    scope: aspect.scope,
  };

  // ── Fill-time size gate for companion pairs (§4, first-fill). ──
  // verify-lock gates a STORED entry against max_prompt_chars, but on a pair's
  // FIRST fill there is no stored entry — verify-lock classifies the pair as
  // `unverified` (not `prompt-too-large`) and fill proceeds, billing the reviewer
  // for a prompt that may then be refused by the gate on the NEXT `yg check`.
  // For plain LLM pairs this cannot happen (verify-lock knows subjects+references
  // on first fill), but companion pairs carry extra bytes verify-lock cannot see
  // without a stored entry. The guard below closes that window: when companions
  // were resolved and injected AND the tier sets a limit, measure BEFORE calling
  // the reviewer. Uses assembledPromptChars (label-free) — the same measurement
  // verify-lock uses — so fill and verify are consistent.
  if (aspect.hasCompanion === true && companions.length > 0) {
    const limit = mergedTier.max_prompt_chars;
    if (limit !== undefined) {
      const chars = assembledPromptChars(promptInput);
      if (chars > limit) {
        const unitKeyPosix = toPosixPath(pair.unitKey);
        return {
          kind: 'infra',
          why: `assembled prompt for aspect '${aspect.id}' on ${unitKeyPosix} is ${chars} chars, over the '${tierName}' tier limit of ${limit}`,
          messageData: {
            what: `Assembled reviewer prompt for aspect '${aspect.id}' on ${unitKeyPosix} is ${chars} chars, over the '${tierName}' tier limit of ${limit}.`,
            why: 'An over-limit prompt risks context-window truncation and a false verdict. The gate blocks the pair and writes NOTHING — no reviewer call is made.',
            next:
              `Remedies, in safety order:\n` +
              `  1. Narrow scope.files so non-target payload (README, fixtures) leaves the prompt.\n` +
              `  2. Switch the aspect to per: file — only if the rule is file-local; see \`yg knowledge read writing-llm-aspects\`.\n` +
              `  3. Split the node so its mapped files divide across smaller nodes.\n` +
              `  4. Raise max_prompt_chars or move the aspect to a higher-limit tier — note: tier edits cascade re-verification across every aspect resolving to that tier.\n` +
              `Then re-run: yg check --approve`,
          },
          callsMade: 0,
        };
      }
    }
  }

  const prompt = buildPairPrompt(promptInput);

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
    tier: tierHashViewFromTier(tierName),
    // companionHash folds UNCONDITIONALLY (undefined for a plain aspect → not
    // folded; a []-resolving companion still folds it). touched folds only when
    // non-empty (the hash guards decide). The two guards are independent.
    companionHash: companionHashFor(aspect),
    touched: observations,
    verdict,
  });

  const entry: VerdictEntry = { verdict, hash };
  // Persist touched ONLY when the companion recorded out-of-subject observations —
  // a []-resolving companion writes NO touched but still folded companionHash.
  if (observations.length > 0) entry.touched = observations;
  if (verdict === 'refused') entry.reason = response.reason;
  return { kind: 'verdict', entry, callsMade: consensus };
}
