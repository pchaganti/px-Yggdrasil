/**
 * source/cli/src/core/verify-lock.ts — the lock-verification engine (spec §6, §3.1, §4).
 *
 * Pure, testable read-side core of `yg check`:
 *   - compute the expected (aspect, unit) pairs (non-draft) from the graph,
 *   - recompute each pair's inputHash from CURRENT inputs + the STORED verdict
 *     token, and compare to the stored entry's hash,
 *   - run the per-pair prompt-size gate for LLM pairs (§4),
 *   - classify each pair as verified / refused / unverified / prompt-too-large.
 *
 * This engine NEVER executes a reviewer and NEVER executes a deterministic
 * check.mjs. For deterministic pairs it re-OBSERVES the stored observation keys
 * (read:/list:/exists:/graph:) against current disk state — a value that changed
 * (or a file/node that vanished) yields a mismatch ⇒ unverified, never a throw
 * (spec §3.1). The fill stage (B2) is the only place check.mjs and the reviewer
 * run; this engine and the fill stage share the same input-assembly helpers so a
 * verdict the fill writes verifies here without re-running anything.
 *
 * Gate representation (the oversized-but-valid case, spec §3.1 / §4):
 *   - If a pair's stored entry is MISSING or its hash MISMATCHES and its assembled
 *     prompt exceeds the tier limit → state = { kind: 'prompt-too-large', ... }.
 *     The gate REPLACES the unverified state (no duplicate unverified, §4 gate
 *     precedence).
 *   - If a pair's stored entry is VALID (verified or refused) but its assembled
 *     prompt now exceeds the tier limit → the verdict state is PRESERVED
 *     (verified/refused) AND the pair additionally carries an `oversized` field.
 *     The check renderer surfaces ONE prompt-too-large error for the pair in
 *     BOTH cases (state.kind === 'prompt-too-large' OR oversized set), and the
 *     valid-verdict pair additionally renders its verified/refused result.
 */

import path from 'node:path';

import { readFileBytes, listDirEntries, statKind } from '../io/graph-fs.js';

import type { Graph, AspectDef } from '../model/graph.js';
import type { LockFile, VerdictEntry } from '../model/lock.js';
import { hashBytes } from '../io/hash.js';
import {
  computeLlmInputHash,
  computeDetInputHash,
  hashReadObservation,
  hashListObservation,
  hashExistsObservation,
} from './pair-hash.js';
import { ruleHashFor, contentFor, nodeDescriptionFor, tierHashViewFromTier } from './pair-inputs.js';
import type { ExpectedPair, UnreadableSubject } from './pairs.js';
import { computeExpectedPairs } from './pairs.js';
import { selectTierForAspect } from './tier-selection.js';
import { assembledPromptChars } from '../llm/prompt.js';
import type { PromptReferenceInput, PromptFileInput } from '../llm/prompt.js';

// ============================================================
// Public types
// ============================================================

/** Per-pair classification produced by lock verification. */
export type PairState =
  | { kind: 'verified' }
  | { kind: 'refused'; reason?: string } // valid entry, verdict refused
  | { kind: 'unverified' } // missing entry or hash mismatch
  | { kind: 'prompt-too-large'; chars: number; limit: number; tierName: string };

/**
 * A verified pair: the expected pair plus its computed state.
 *
 * `oversized` is set ONLY for the valid-verdict-but-now-oversized case: the
 * stored verdict is still valid (state is verified/refused), but the pair's
 * assembled prompt exceeds the resolved tier's max_prompt_chars. The renderer
 * emits a prompt-too-large error for the pair AND renders the preserved verdict.
 * When the pair is itself unverified-and-oversized, the state is
 * { kind: 'prompt-too-large' } and `oversized` is left undefined (the gate state
 * already carries chars/limit/tierName).
 */
export interface VerifiedPair {
  pair: ExpectedPair;
  state: PairState;
  /** Valid-verdict-but-oversized: gate error data to surface alongside the verdict. */
  oversized?: { chars: number; limit: number; tierName: string };
}

export interface LockVerification {
  pairs: VerifiedPair[];
  /** From PairComputation — callers MUST render as blocking file-unreadable errors. */
  unreadable: UnreadableSubject[];
}

// ============================================================
// verifyLock
// ============================================================

/**
 * Verify a loaded graph against a lock file. Pure read — no writes, no LLM
 * calls, no check.mjs execution. Returns a per-pair classification plus the
 * unreadable-subject list from pair computation.
 */
export async function verifyLock(graph: Graph, lock: LockFile): Promise<LockVerification> {
  const { pairs, unreadable } = await computeExpectedPairs(graph);
  const projectRoot = path.dirname(graph.rootPath);

  // Index aspect defs by id for O(1) lookup.
  const aspectById = new Map<string, AspectDef>();
  for (const a of graph.aspects) aspectById.set(a.id, a);

  // Cache file byte reads across pairs (subject files, references, observations).
  const byteCache = new Map<string, Buffer | null>();
  const readBytes = async (absPath: string): Promise<Buffer | null> => {
    if (byteCache.has(absPath)) return byteCache.get(absPath)!;
    const bytes = await readFileBytes(absPath);
    byteCache.set(absPath, bytes);
    return bytes;
  };

  // Memoize content digests: a file appearing in many pairs is hashed once per run.
  const digestCache = new Map<string, string>();
  const hashCached = (absPath: string, bytes: Buffer): string => {
    const hit = digestCache.get(absPath);
    if (hit !== undefined) return hit;
    const digest = hashBytes(bytes);
    digestCache.set(absPath, digest);
    return digest;
  };

  const verified: VerifiedPair[] = [];

  for (const pair of pairs) {
    const aspect = aspectById.get(pair.aspectId);
    // Defensive: pairs come from the same graph, so the aspect always exists.
    /* v8 ignore next */
    if (!aspect) continue;

    const storedEntry = lock.verdicts[pair.aspectId]?.[pair.unitKey];

    if (pair.kind === 'llm') {
      verified.push(
        await verifyLlmPair(pair, aspect, graph, lock, projectRoot, storedEntry, readBytes, hashCached),
      );
    } else {
      verified.push(
        await verifyDetPair(pair, aspect, projectRoot, storedEntry, readBytes, hashCached),
      );
    }
  }

  return { pairs: verified, unreadable };
}

// ============================================================
// LLM pair verification
// ============================================================

async function verifyLlmPair(
  pair: ExpectedPair,
  aspect: AspectDef,
  graph: Graph,
  lock: LockFile,
  projectRoot: string,
  storedEntry: VerdictEntry | undefined,
  readBytes: (absPath: string) => Promise<Buffer | null>,
  hashCached: (absPath: string, bytes: Buffer) => string,
): Promise<VerifiedPair> {
  // ── Resolve the tier (needed for both validity recompute and the gate). ──
  const reviewer = graph.config.reviewer;
  const tierResult = reviewer ? selectTierForAspect(aspect, reviewer) : undefined;

  // ── Load subject file bytes once: used for both hash recompute and prompt. ──
  const subjects: Array<{ path: string; bytes: Buffer }> = [];
  for (const rel of pair.subjectFiles) {
    const bytes = await readBytes(path.resolve(projectRoot, rel));
    // A subject file that vanished cannot be hashed or prompted; treat its
    // content as empty bytes so the recompute differs from the stored hash
    // (the file change drove the disappearance ⇒ unverified) and the prompt
    // gate still measures the remaining payload deterministically.
    subjects.push({ path: rel, bytes: bytes ?? Buffer.alloc(0) });
  }

  // ── Load reference bytes (sorted by path is handled inside the hash fn). ──
  const refInputs = aspect.references ?? [];
  const referencesForHash: Array<[string, string, string]> = [];
  const referencesForPrompt: PromptReferenceInput[] = [];
  for (const ref of refInputs) {
    const absRef = path.resolve(projectRoot, ref.path);
    const bytes = await readBytes(absRef);
    const refBytes = bytes ?? Buffer.alloc(0);
    referencesForHash.push([ref.path, hashCached(absRef, refBytes), ref.description ?? '']);
    referencesForPrompt.push({
      path: ref.path,
      description: ref.description,
      content: refBytes.toString('utf8'),
    });
  }

  // ── ruleHash = sha256(content.md bytes). Artifacts carry the loaded text. ──
  const ruleHash = ruleHashFor(aspect, 'content.md');

  // ── Prompt-size gate (§4): only when a tier resolves and sets a limit. ──
  let gate: { chars: number; limit: number; tierName: string } | undefined;
  if (tierResult?.ok) {
    const limit = tierResult.tier.max_prompt_chars;
    if (limit !== undefined) {
      const chars = assembledPromptChars({
        aspect: {
          id: aspect.id,
          description: aspect.description ?? '',
          content: contentFor(aspect, 'content.md'),
        },
        references: referencesForPrompt,
        nodePath: pair.nodePath,
        nodeDescription: nodeDescriptionFor(graph, pair.nodePath),
        files: subjects.map<PromptFileInput>((s) => ({
          path: s.path,
          content: s.bytes.toString('utf8'),
        })),
        scope: aspect.scope,
      });
      if (chars > limit) {
        gate = { chars, limit, tierName: tierResult.tierName };
      }
    }
  }

  // ── Validity recompute. Requires a resolvable tier; if the tier cannot be
  //    resolved we cannot reproduce the stored hash, so the pair is unverified
  //    (the fill stage would have failed closed and written nothing). ──
  let valid = false;
  if (storedEntry !== undefined && tierResult?.ok) {
    const expectedHash = computeLlmInputHash({
      aspectId: aspect.id,
      aspectDescription: aspect.description ?? '',
      scope: aspect.scope,
      nodePath: pair.nodePath,
      ruleHash,
      files: subjects.map((s) => [s.path, hashCached(path.resolve(projectRoot, s.path), s.bytes)] as [string, string]),
      references: referencesForHash,
      tier: tierHashViewFromTier(tierResult.tierName, tierResult.tier),
      verdict: storedEntry.verdict,
    });
    valid = expectedHash === storedEntry.hash;
  }

  return classifyWithGate(pair, storedEntry, valid, gate);
}

// ============================================================
// Deterministic pair verification
// ============================================================

async function verifyDetPair(
  pair: ExpectedPair,
  aspect: AspectDef,
  projectRoot: string,
  storedEntry: VerdictEntry | undefined,
  readBytes: (absPath: string) => Promise<Buffer | null>,
  hashCached: (absPath: string, bytes: Buffer) => string,
): Promise<VerifiedPair> {
  let valid = false;

  if (storedEntry !== undefined) {
    // Re-observe the CURRENT value of every STORED touched key. A value that
    // changed — or a file/dir/node that vanished — yields a mismatch ⇒ the
    // recomputed hash differs ⇒ unverified. Re-observation NEVER throws.
    const stored = storedEntry.touched ?? [];
    const touchedNow: Array<[string, string]> = [];
    for (const [key] of stored) {
      const nowHash = await reObserve(key, projectRoot, readBytes);
      touchedNow.push([key, nowHash]);
    }

    // Subject file hashes from current disk (a vanished subject hashes empty,
    // which differs from any stored content ⇒ unverified).
    const files: Array<[string, string]> = [];
    for (const rel of pair.subjectFiles) {
      const absPath = path.resolve(projectRoot, rel);
      const bytes = await readBytes(absPath);
      const buf = bytes ?? Buffer.alloc(0);
      files.push([rel, hashCached(absPath, buf)]);
    }

    const ruleHash = ruleHashFor(aspect, 'check.mjs');

    const expectedHash = computeDetInputHash({
      aspectId: aspect.id,
      scope: aspect.scope,
      nodePath: pair.nodePath,
      ruleHash,
      files,
      touched: touchedNow,
      verdict: storedEntry.verdict,
    });
    valid = expectedHash === storedEntry.hash;
  }

  // Deterministic pairs have no prompt and are not subject to the gate (§4).
  return classifyWithGate(pair, storedEntry, valid, undefined);
}

// ============================================================
// Classification + gate precedence
// ============================================================

/**
 * Turn a validity verdict + optional gate into a VerifiedPair, applying §4 gate
 * precedence:
 *   - invalid/missing entry + gate trips → prompt-too-large state (replaces
 *     unverified; no duplicate);
 *   - invalid/missing entry + no gate → unverified;
 *   - valid entry (verified/refused) + gate trips → verdict state preserved,
 *     gate surfaced via `oversized`;
 *   - valid entry + no gate → verdict state only.
 */
function classifyWithGate(
  pair: ExpectedPair,
  storedEntry: VerdictEntry | undefined,
  valid: boolean,
  gate: { chars: number; limit: number; tierName: string } | undefined,
): VerifiedPair {
  if (valid && storedEntry !== undefined) {
    const verdictState: PairState =
      storedEntry.verdict === 'refused'
        ? { kind: 'refused', reason: storedEntry.reason }
        : { kind: 'verified' };
    if (gate) {
      return { pair, state: verdictState, oversized: gate };
    }
    return { pair, state: verdictState };
  }

  // Invalid or missing entry.
  if (gate) {
    return {
      pair,
      state: { kind: 'prompt-too-large', chars: gate.chars, limit: gate.limit, tierName: gate.tierName },
    };
  }
  return { pair, state: { kind: 'unverified' } };
}

// ============================================================
// Re-observation (deterministic validity)
// ============================================================

/**
 * Sentinel hash for a re-observation whose target vanished. It is NOT a valid
 * 64-hex sha256, so it can never equal a stored content hash — a deleted file,
 * dir, or node therefore always reads as a CHANGED value (⇒ unverified), and
 * never collides with a genuinely-empty stored observation. (spec §3.1: missing
 * during re-observation = changed value, never a throw.)
 */
const MISSING_OBSERVATION = 'missing';

/**
 * Re-observe the CURRENT value for a stored observation key and return its hash
 * using the frozen observation-hash helpers. Mirrors the runner's recording
 * (ObservationRecorder) so an unchanged value reproduces the stored hash.
 */
async function reObserve(
  key: string,
  projectRoot: string,
  readBytes: (absPath: string) => Promise<Buffer | null>,
): Promise<string> {
  const sep = key.indexOf(':');
  /* v8 ignore next -- observation keys are always '<kind>:<path>' by construction */
  if (sep < 0) return MISSING_OBSERVATION;
  const kind = key.slice(0, sep);
  const target = key.slice(sep + 1);

  switch (kind) {
    case 'read': {
      const bytes = await readBytes(path.resolve(projectRoot, target));
      return bytes === null ? MISSING_OBSERVATION : hashReadObservation(bytes);
    }
    case 'graph': {
      // graph:<nodePath> hashes the node's yg-node.yaml bytes (runner contract).
      const ygNodePath = path.resolve(projectRoot, '.yggdrasil', 'model', target, 'yg-node.yaml');
      const bytes = await readBytes(ygNodePath);
      return bytes === null ? MISSING_OBSERVATION : hashReadObservation(bytes);
    }
    case 'list': {
      const entries = await listDir(path.resolve(projectRoot, target));
      return entries === null ? MISSING_OBSERVATION : hashListObservation(entries);
    }
    case 'exists': {
      const result = await existsProbe(path.resolve(projectRoot, target));
      return hashExistsObservation(result);
    }
    /* v8 ignore next 2 -- unknown kind never produced by observationKey() */
    default:
      return MISSING_OBSERVATION;
  }
}

async function listDir(absDir: string): Promise<Array<{ name: string; kind: 'file' | 'dir' }> | null> {
  return listDirEntries(absDir);
}

async function existsProbe(absPath: string): Promise<'file' | 'dir' | false> {
  return statKind(absPath);
}

