/**
 * source/cli/src/core/pair-inputs.ts — shared input-assembly helpers for the
 * verdict lock's two directions (spec §3.1).
 *
 * The fill stage (core/fill.ts) PRODUCES verdict hashes; the check stage
 * (core/verify-lock.ts) RE-VERIFIES them. Both must fold byte-identical
 * ingredients or every written verdict reads back as `unverified`. These helpers
 * are the single implementation of the non-IO parts of that fold:
 *
 *   - ruleHashFor / contentFor — the rule-source bytes (content.md / check.mjs)
 *     loaded into the graph as UTF-8 text (contract #1).
 *   - tierHashViewFromTier — strips the non-judgment fields (provider/consensus
 *     are folded separately; max_prompt_chars + references caps are GATES, not
 *     inputs) and delegates api_key/timeout stripping to tierHashView (contract #3).
 *   - nodeDescriptionFor — the node description that garnishes the prompt (NOT
 *     hashed; exposed here only so both sides assemble the prompt identically).
 *
 * The IO policy DIFFERS between the two sides and therefore stays at the call
 * site: check substitutes empty bytes for a missing reference/subject (a change
 * that drove the disappearance ⇒ unverified), while fill treats a missing
 * reference as a LOUD infra failure and writes nothing (contract #6). These
 * helpers only see already-loaded bytes / hashes, so they cannot diverge on that
 * policy.
 */

import type { Graph, AspectDef, LlmConfig } from '../model/graph.js';
import { hashBytes } from '../io/hash.js';
import { tierHashView } from './pair-hash.js';
import type { LlmHashInput } from './pair-hash.js';

/** Text content of the named rule-source artifact (empty string if absent). */
export function contentFor(aspect: AspectDef, filename: 'content.md' | 'check.mjs'): string {
  const art = aspect.artifacts.find((a) => a.filename === filename);
  return art?.content ?? '';
}

/**
 * sha256 of the named rule-source artifact's bytes (content.md or check.mjs).
 * Contract #1: hashBytes over the graph-loaded UTF-8 text — producer and
 * verifier MUST use this one implementation.
 */
export function ruleHashFor(aspect: AspectDef, filename: 'content.md' | 'check.mjs'): string {
  return hashBytes(Buffer.from(contentFor(aspect, filename), 'utf8'));
}

/** The node's description (prompt garnish — not hashed; spec §3.1). */
export function nodeDescriptionFor(graph: Graph, nodePath: string): string {
  return graph.nodes.get(nodePath)?.meta.description ?? '';
}

/**
 * Build the tier hash view from a resolved LlmConfig (contract #3). Strips the
 * non-judgment fields:
 *   - provider / consensus fold separately (carried by tierHashView's own fields)
 *   - max_prompt_chars + references caps are GATES (§4), never verdict inputs
 * then lets tierHashView strip api_key + timeout. The remaining config knobs
 * (model, endpoint, temperature, …custom) fold into the hash. Does NOT mutate
 * its input.
 */
export function tierHashViewFromTier(tierName: string, tier: LlmConfig): LlmHashInput['tier'] {
  const {
    provider,
    consensus,
    // Excluded gates — never fold into the verdict hash.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    max_prompt_chars: _mpc,
    ...rest
  } = tier;
  return tierHashView(tierName, { provider, consensus, config: rest });
}
