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
import { computeLlmInputHash, observationKey, hashReadObservation } from './pair-hash.js';
import { ruleHashFor, contentFor, nodeDescriptionFor, tierHashViewFromTier, companionHashFor } from './pair-inputs.js';
import { computeNodeMappedFiles } from './pairs.js';
import { hashBytes } from '../io/hash.js';
import { buildPairPrompt } from '../llm/prompt.js';
import type { PromptReferenceInput, PromptFileInput, PromptCompanionInput } from '../llm/prompt.js';
import { verifyWithConsensus } from '../llm/aspect-verifier.js';
import type { LlmProvider } from '../llm/types.js';
import { readFileBytes } from '../io/graph-fs.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosix, toPosixPath } from '../utils/posix.js';
import { runCompanionHook } from '../structure/hook-loader.js';
import { collectAllowedReadsForAspect } from '../structure/allowed-reads.js';
import { resolveAllowedReadPath } from '../structure/ctx-fs.js';
import { buildOwnerIndex } from '../relations/owner-index.js';
import type { IssueMessage } from '../model/validation.js';
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

  // ── Normalize each returned path to repo-root-relative POSIX, dedupe + sort. ──
  const allowedSet = collectAllowedReadsForAspect(pair.nodePath, graph);
  const subjectSet = new Set(pair.subjectFiles.map((p) => toPosix(p)));
  const normalizedSet = new Set<string>();
  for (const d of run.descriptors) {
    // Normalize to repo-root-relative POSIX. A path escaping the repo root is an
    // allowed-reads guard failure (handled below by resolveAllowedReadPath).
    const abs = path.resolve(projectRoot, d.path.replace(/\\/g, '/'));
    const rel = toPosix(path.relative(projectRoot, abs));
    // Subject-read dedupe: a returned path equal to a unit subject is already a
    // subject (hashed + prompted as such) — drop it, never inject, never record.
    if (subjectSet.has(rel)) continue;
    normalizedSet.add(rel);
  }
  const sortedPaths = [...normalizedSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // ── Validate + read each remaining companion path. Build prompt + observations. ──
  const promptCompanions: PromptCompanionInput[] = [];
  // Combine the hook's own out-of-subject observations (reads it made to RESOLVE)
  // with a read: observation per companion file fill-llm itself reads. Both are
  // inputs that must invalidate the verdict on edit. Dedupe by key (a path read
  // both by the hook and re-read here hashes identically — collapse to one).
  const obsByKey = new Map<string, string>();
  for (const [k, h] of run.observations) obsByKey.set(k, h);

  // Label lookup so the prompt can carry the author's optional label per path.
  const labelByPath = new Map<string, string | undefined>();
  for (const d of run.descriptors) {
    const abs = path.resolve(projectRoot, d.path.replace(/\\/g, '/'));
    const rel = toPosix(path.relative(projectRoot, abs));
    if (!labelByPath.has(rel)) labelByPath.set(rel, d.label);
  }

  for (const rel of sortedPaths) {
    // Allowed-reads guard (shared with ctx.fs): normalizes, rejects repo-escape,
    // enforces the allow-set, and re-checks the real (symlink-resolved) path. Any
    // failure → infra with a relation-source/target NEXT.
    try {
      resolveAllowedReadPath(rel, allowedSet, projectRoot);
    } catch {
      return { kind: 'infra', ...companionOutsideAllowedReads(graph, pair, aspect, rel) };
    }
    const bytes = await readFileBytes(path.resolve(projectRoot, rel));
    if (bytes === null) {
      const what = `Companion file '${rel}' for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} could not be read.`;
      const why = 'A resolved companion is part of the verifier input; reading empty-substituted bytes would desync the producer and verifier and pin a false verdict, so the fill fails closed and writes NOTHING.';
      const next = `Restore the file at '${rel}' or fix companion.mjs so it returns only existing, relation-reachable paths, then re-run: yg check --approve`;
      return { kind: 'infra', why: `companion '${rel}' could not be read`, messageData: { what, why, next } };
    }
    promptCompanions.push({ path: rel, content: bytes.toString('utf8'), ...(labelByPath.get(rel) !== undefined ? { label: labelByPath.get(rel) } : {}) });
    obsByKey.set(observationKey('read', rel), hashReadObservation(bytes));
  }

  const observations = [...obsByKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { kind: 'ok', companions: { promptCompanions, observations } };
}

/**
 * Build the infra messageData for a companion path that resolved OUTSIDE the
 * node's allowed-reads (or escaped the repo root). The NEXT frames the relation
 * SOURCE as pair.nodePath and the TARGET as the owner of the companion path —
 * NEVER pair.subjectFiles / unitKey (a per:file .md subject cannot hold a
 * relation). When the path is unmapped (no owner) the NEXT says so.
 */
function companionOutsideAllowedReads(
  graph: Graph,
  pair: ExpectedPair,
  aspect: AspectDef,
  rel: string,
): { why: string; messageData: IssueMessage } {
  const owner = buildOwnerIndex(graph.nodes).ownerOf(rel);
  const what = `Companion file '${rel}' for aspect '${aspect.id}' on ${toPosixPath(pair.unitKey)} is outside the node's allowed-reads.`;
  const why = 'A companion must be relation-reachable from the reviewed node — the reviewer may only see files the graph permits the node to read, so an out-of-reach companion is an infrastructure fault and the fill fails closed (NOTHING written).';
  const next = owner === undefined
    ? `The path '${rel}' is unmapped (no node owns it). Map it to a node and declare a relation from ${toPosixPath(pair.nodePath)} to that node in .yggdrasil/model/${toPosixPath(pair.nodePath)}/yg-node.yaml, or fix companion.mjs to return only relation-reachable paths.`
    : `declare a relation from ${toPosixPath(pair.nodePath)} to ${toPosixPath(owner)} in .yggdrasil/model/${toPosixPath(pair.nodePath)}/yg-node.yaml, or fix companion.mjs to return only relation-reachable paths.`;
  return { why: `companion '${rel}' is outside the node's allowed-reads`, messageData: { what, why, next } };
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

  const prompt = buildPairPrompt({
    aspect: { id: aspect.id, description: aspect.description ?? '', content: contentFor(aspect, 'content.md') },
    references: referencesForPrompt,
    nodePath: pair.nodePath,
    nodeDescription: nodeDescriptionFor(graph, pair.nodePath),
    files: subjects.map<PromptFileInput>((s) => ({ path: s.path, content: s.bytes.toString('utf8') })),
    companions,
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
