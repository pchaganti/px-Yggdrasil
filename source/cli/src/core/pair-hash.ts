/**
 * source/cli/src/core/pair-hash.ts — FROZEN CONTRACT (spec §3.1).
 *
 * Computes the content-addressed inputHash stored in the verdict lock for every
 * (aspect, unit) pair — LLM and deterministic alike.
 *
 * BREAKING: changing serialization format, key names, or included ingredients is
 * a deliberate breaking decision that invalidates every stored verdict. Golden
 * tests in pair-hash.test.ts pin the canonical output.
 *
 * Design choices (each exclusion documented with rationale):
 *   - status         — rendering only; advisory ↔ enforced flips must NOT invalidate verdicts
 *   - reason         — free text; only the discrete verdict token ('approved'/'refused') folds
 *   - node description — prompt garnish, not a judgment input (matches prior system for node descriptors)
 *   - CLI version    — upgrading Yggdrasil must not cascade re-verification across every node
 *   - timeout        — transport knob; historically made timeout tuning cascade across every node
 *   - when/implies/ports — applicability recomputed live; acts through expected-pair set, not hashing
 */

import type { ScopeDef } from '../model/graph.js';
import type { Verdict } from '../model/lock.js';
import { hashString } from '../io/hash.js';

// ============================================================
// Public input types
// ============================================================

export interface CommonHashInput {
  aspectId: string;
  scope: ScopeDef | undefined;          // normalized internally: undefined → {per:'node'}
  nodePath: string;                     // owning node — pins per-file units to their review context
  ruleHash: string;                     // sha256 of content.md or check.mjs bytes
  files: Array<[string, string]>;       // subject [posixPath, sha256(bytes)] — sorted internally
  verdict: Verdict;
}

export interface LlmHashInput extends CommonHashInput {
  aspectDescription: string;
  references: Array<[string, string, string]>; // [path, sha256(bytes), description] — sorted internally by path
  tier: { name: string; provider: string; consensus: number;
          config: Record<string, unknown> };   // caller already stripped api_key + timeout
}

export interface DetHashInput extends CommonHashInput {
  touched: Array<[string, string]>;     // [observationKey, observationHash] — sorted internally by key
}

// ============================================================
// codePointCanonicalJson — the single serialization primitive
// ============================================================

/**
 * Serialize any JSON-representable value to a canonical JSON string where
 * object keys are sorted in Unicode code-point order (never localeCompare —
 * localeCompare is environment-sensitive and therefore banned from any path
 * that contributes to a stored hash).
 *
 * Rules:
 *   - null and primitives: standard JSON.stringify
 *   - arrays: elements in their existing order (callers sort before passing)
 *   - objects: keys sorted by code-point, undefined values omitted
 */
export function codePointCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(codePointCanonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  // Code-point sort: String.prototype.localeCompare is NEVER used here.
  // The standard < / > comparator on strings is code-point order for BMP chars.
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${codePointCanonicalJson(v)}`).join(',')}}`;
}

// ============================================================
// POSIX path normalization
// ============================================================

/** Replace every backslash with forward-slash. Called on every path before hashing. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

// ============================================================
// Scope normalization
// ============================================================

/**
 * Normalize scope: absent (undefined) is canonically identical to {per:'node'}
 * with no files filter. The scope predicate structure folds in its parsed form
 * via codePointCanonicalJson so a scope edit cascades to the hash.
 */
function normalizeScope(scope: ScopeDef | undefined): { per: string; files?: unknown } {
  if (scope === undefined) return { per: 'node' };
  if (scope.files === undefined) return { per: scope.per };
  return { per: scope.per, files: scope.files };
}

// ============================================================
// Common canonical object builder
// ============================================================

function buildCommonCanonical(input: CommonHashInput): Record<string, unknown> {
  // Sort files by path (code-point order); POSIX-normalize all paths.
  const files = [...input.files]
    .map(([p, h]) => [toPosix(p), h] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, h]) => [p, h]);

  return {
    aspect: input.aspectId,
    files,
    node: input.nodePath,
    rule: input.ruleHash,
    scope: normalizeScope(input.scope),
    verdict: input.verdict,
  };
}

// ============================================================
// computeLlmInputHash
// ============================================================

/**
 * Compute the inputHash for an LLM (aspect, unit) pair.
 *
 * Ingredients (spec §3.1):
 *   common: aspect, scope, node, rule, files, verdict
 *   LLM-only: aspectDescription, references, tier (config excludes api_key + timeout)
 *
 * Hash = sha256(codePointCanonicalJson(canonical_object)) where canonical_object
 * includes a 'kind: "llm"' discriminator so LLM and deterministic pairs can never
 * collide even if all other fields match.
 */
export function computeLlmInputHash(input: LlmHashInput): string {
  const common = buildCommonCanonical(input);

  // Sort references by path; POSIX-normalize paths.
  const references = [...input.references]
    .map(([p, h, d]) => [toPosix(p), h, d] as [string, string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, h, d]) => [p, h, d]);

  const canonical: Record<string, unknown> = {
    ...common,
    aspectDescription: input.aspectDescription,
    kind: 'llm',
    references,
    tier: {
      config: input.tier.config,
      consensus: input.tier.consensus,
      name: input.tier.name,
      provider: input.tier.provider,
    },
  };

  return hashString(codePointCanonicalJson(canonical));
}

// ============================================================
// computeDetInputHash
// ============================================================

/**
 * Compute the inputHash for a deterministic (aspect, unit) pair.
 *
 * Ingredients (spec §3.1):
 *   common: aspect, scope, node, rule, files, verdict
 *   deterministic-only: touched (observation set — sorted by key internally)
 *
 * Hash = sha256(codePointCanonicalJson(canonical_object)) where canonical_object
 * includes a 'kind: "deterministic"' discriminator so deterministic and LLM pairs
 * can never collide even if all other fields match.
 */
export function computeDetInputHash(input: DetHashInput): string {
  const common = buildCommonCanonical(input);

  // Sort touched by observation key (code-point order); POSIX paths in keys are
  // already encoded by observationKey() which normalizes them at recording time.
  const touched = [...input.touched]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, h]) => [k, h]);

  const canonical: Record<string, unknown> = {
    ...common,
    kind: 'deterministic',
    touched,
  };

  return hashString(codePointCanonicalJson(canonical));
}

// ============================================================
// Observation helpers
// ============================================================

/**
 * Encode an observation key for a deterministic check's ctx read boundary.
 *
 * Format: '<kind>:<path>' where path is the repo-relative POSIX path (for
 * read/list/exists) or the model-relative node path (for graph).
 *
 * Key encoding is part of the frozen contract — changing it changes all
 * deterministic hashes that include observations.
 */
export function observationKey(kind: 'read' | 'list' | 'exists' | 'graph', path: string): string {
  return `${kind}:${path}`;
}

/**
 * Hash a file-read observation: sha256 of the raw bytes the check read.
 * Used by the runner to record 'read:<path>' entries in touched[].
 */
export function hashReadObservation(bytes: Buffer): string {
  return hashString(bytes.toString('binary'));
}

/**
 * Hash a directory-listing observation.
 *
 * Contract: sha256 over the sorted 'name:kind' lines (newline-joined), so
 * the order in which entries are returned by readdir does not affect the hash.
 * Both the name set AND the kind annotations fold — renaming a file or changing
 * a dir-to-file swap both invalidate the verdict.
 *
 * This value is golden-pinned in pair-hash-golden.json.
 */
export function hashListObservation(entries: Array<{ name: string; kind: 'file' | 'dir' }>): string {
  const lines = [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${e.name}:${e.kind}`)
    .join('\n');
  return hashString(lines);
}

/**
 * Hash an existence-probe observation.
 *
 * Encodes the result as a string token so the three outcomes ('file', 'dir', false)
 * produce distinct hashes — a file renamed to a directory invalidates the verdict.
 */
export function hashExistsObservation(result: 'file' | 'dir' | false): string {
  return hashString(result === false ? 'false' : result);
}

// ============================================================
// tierHashView — strips api_key + timeout without mutating input
// ============================================================

/**
 * Build the tier view used in LlmHashInput.tier. Strips api_key and timeout
 * from the tier's config — these are the ONLY exclusions from config; every
 * other config key folds into the hash.
 *
 *   api_key — rotated independently; its value is not a judgment input
 *   timeout — transport knob; historically made timeout tuning cascade across
 *             every node without changing any reviewer output
 *
 * Does NOT mutate its input.
 */
export function tierHashView(
  tierName: string,
  llm: { provider: string; consensus: number; config: Record<string, unknown> },
): LlmHashInput['tier'] {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { api_key: _a, timeout: _t, ...rest } = llm.config;
  return {
    name: tierName,
    provider: llm.provider,
    consensus: llm.consensus,
    config: rest,
  };
}
