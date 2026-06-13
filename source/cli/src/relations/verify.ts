/**
 * Parse-free re-validation of relation-conformance verdicts.
 *
 * Plain `yg check` must re-validate every stored relation verdict WITHOUT
 * parsing any source file — tree-sitter is reserved for `yg check --approve`
 * (the parse-heavy pass in `relations/pass.ts`). This module reads and hashes
 * source bytes, then rebuilds the exact `FingerprintInput` the pass observed
 * from the stored evidence and the current tree, and compares fingerprints.
 *
 * Every fingerprint construction (indexIdentity, the sources sort, the relations
 * hash, the basis string) is taken from the SHARED `fingerprint-build.ts`
 * helpers — the same helpers the pass uses — so a freshly-sealed verdict reads
 * back as verified on an unchanged tree and the two sides cannot drift.
 *
 * NEVER import or call tree-sitter `parseFile` here. Symbol-keyed dependencies
 * cannot be re-resolved without the symbol table (which requires parsing); they
 * are instead re-checked against on-disk reality from the stored outcome, and
 * any new colliding definition changes `indexIdentity` (→ fingerprint differs →
 * the node falls back to unverified, where `--approve` re-parses).
 */
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import { nodeUnit } from '../model/lock.js';
import { getLanguageForExtension } from '../core/graph/language-registry.js';
import { codePointCanonicalJson } from '../core/pair-hash.js';
import { expandMappingPaths, hashString } from '../io/hash.js';

import { buildOwnerIndex } from './owner-index.js';
import {
  computeFingerprint,
  type DepOutcome,
  type FingerprintInput,
  type Outcome,
} from './fingerprint.js';
import {
  computeBasis,
  computeIndexIdentity,
  hashRelations,
  sortFileHashPairs,
} from './fingerprint-build.js';
import {
  verifyNodeDeps,
  type ResolvedDep,
  type RelationGraphView,
  type Violation,
} from './verifier.js';

export type RelationState =
  | { nodeId: string; kind: 'verified' }
  | { nodeId: string; kind: 'refused'; reason?: string; violations: Violation[] }
  | { nodeId: string; kind: 'unverified' };

export interface VerifyDeps {
  /** Same path-resolution injected into the pass — re-resolves `path:` hints. */
  resolvePathToFile: (specifier: string, fromFile: string, language: string) => string | undefined;
  /** Returns a truthy extractor handle for a language the pass would parse.
   *  Only its presence matters here (we never parse) — it selects the same
   *  symbol-language universe the pass used to build indexIdentity. */
  extractorFor: (language: string) => unknown | undefined;
}

/**
 * Re-validate every node's relation verdict against the current tree without
 * parsing. Returns one state per node that has mapped files (the same set the
 * pass produces verdicts for): `verified` / `refused` when the stored verdict's
 * fingerprint still matches, `unverified` when it cannot be confirmed.
 */
export async function verifyRelationConformance(
  graph: Graph,
  lock: LockFile,
  deps: VerifyDeps,
): Promise<RelationState[]> {
  const projectRoot = path.dirname(graph.rootPath);
  const ownerIndex = buildOwnerIndex(graph.nodes);

  const hashOnDisk = (repoRel: string): string | undefined => {
    const abs = path.resolve(projectRoot, repoRel);
    if (!existsSync(abs)) return undefined;
    try {
      return hashString(readFileSync(abs, 'utf-8'));
    } catch {
      return undefined;
    }
  };

  // 1. Enumerate every node's mapped files; read+hash. Build the symbol-language
  //    universe (extractor-backed languages) so indexIdentity matches the pass.
  //    Each file is read at most once (a file mapped under two nodes is shared).
  const currentHashByFile = new Map<string, string>();
  const mappedFilesByNode = new Map<string, string[]>();
  const symbolSources: Array<[string, string]> = [];
  const seenForIdentity = new Set<string>();

  for (const [nodeId, node] of graph.nodes) {
    const mapping = node.meta.mapping ?? [];
    if (mapping.length === 0) continue;
    const files = await expandMappingPaths(projectRoot, mapping);
    mappedFilesByNode.set(nodeId, files);
    for (const rel of files) {
      let hash = currentHashByFile.get(rel);
      if (hash === undefined) {
        hash = hashOnDisk(rel);
        if (hash === undefined) continue; // unreadable → skip (mirrors pass.ts)
        currentHashByFile.set(rel, hash);
      }
      const lang = getLanguageForExtension(path.extname(rel));
      if (lang && deps.extractorFor(lang) && !seenForIdentity.has(rel)) {
        seenForIdentity.add(rel);
        symbolSources.push([rel, hash]);
      }
    }
  }

  // 2. Index identity over the symbol-language source set — shared with pass.ts.
  const currentIndexIdentity = computeIndexIdentity(symbolSources);

  // Graph view for reconstructing a refused node's structured violations from its
  // re-derived outcomes — same shape pass.ts feeds verifyNodeDeps, so the
  // recomputed violations match what the pass recorded for an unchanged tree.
  const graphView: RelationGraphView = {
    isAncestorOf(a, b) {
      return b.startsWith(a + '/');
    },
    declaredTargets(id) {
      return new Set((graph.nodes.get(id)?.meta.relations ?? []).map((r) => r.target));
    },
    parentChain(id) {
      const chain: string[] = [];
      let cur = id;
      while (cur.includes('/')) {
        cur = cur.slice(0, cur.lastIndexOf('/'));
        chain.push(cur);
      }
      return chain;
    },
  };

  const results: RelationState[] = [];

  for (const [nodeId, node] of graph.nodes) {
    const mappedFiles = mappedFilesByNode.get(nodeId);
    if (!mappedFiles || mappedFiles.length === 0) continue; // no verdict for this node

    const stored = lock.relation_verdicts[nodeUnit(nodeId)];
    if (!stored) {
      results.push({ nodeId, kind: 'unverified' });
      continue;
    }

    // 3. Current sources for this node, read+hash, sorted canonically.
    const currentSources: Array<[string, string]> = [];
    for (const rel of mappedFiles) {
      const hash = currentHashByFile.get(rel);
      if (hash === undefined) continue; // unreadable → skip (mirrors pass.ts enumeration)
      currentSources.push([rel, hash]);
    }
    const sortedSources = sortFileHashPairs(currentSources);
    const storedSources = sortFileHashPairs([...stored.evidence.sources]);
    if (codePointCanonicalJson(sortedSources) !== codePointCanonicalJson(storedSources)) {
      // Source bytes or file set changed → re-approve re-parses.
      results.push({ nodeId, kind: 'unverified' });
      continue;
    }

    // 4. Relations hash — shared with pass.ts.
    const currentRelations = hashRelations(node.meta.relations);
    const declaredTargets = new Set((node.meta.relations ?? []).map((r) => r.target));

    // 5. Re-derive each stored outcome against current on-disk reality. `path:`
    //    hints are re-resolved via the injected resolver; `symbol:` hints cannot
    //    be re-resolved without parsing, so the stored outcome is re-checked
    //    against the owner index and disk. A new colliding symbol changes
    //    indexIdentity (step 2) → fingerprint differs → unverified anyway.
    const currentOutcomes: DepOutcome[] = [];
    for (const o of stored.evidence.outcomes) {
      const lang = getLanguageForExtension(path.extname(o.fromFile));
      let outcome: Outcome;

      if (o.hintKey.startsWith('path:')) {
        const spec = o.hintKey.slice('path:'.length);
        const file = deps.resolvePathToFile(spec, o.fromFile, lang ?? '');
        const owner = file ? ownerIndex.ownerOf(file) : undefined;
        if (file && owner) {
          outcome = {
            ownerNode: owner,
            resolvedFile: file,
            resolvedFileHash: currentHashByFile.get(file) ?? hashOnDisk(file) ?? '',
            basis: computeBasis(declaredTargets, owner),
          };
        } else {
          outcome = { external: true };
        }
      } else if (o.hintKey.startsWith('symbol:')) {
        const prior = o.outcome;
        if ('resolvedFile' in prior) {
          // Stored outcome was resolved — re-validate the resolved file still
          // exists and still belongs to the same owner. Cannot re-resolve the
          // symbol itself (that needs the symbol table = parsing).
          const file = prior.resolvedFile;
          if (existsSync(path.resolve(projectRoot, file)) && ownerIndex.ownerOf(file) === prior.ownerNode) {
            outcome = {
              ownerNode: prior.ownerNode,
              resolvedFile: file,
              resolvedFileHash: currentHashByFile.get(file) ?? hashOnDisk(file) ?? '',
              basis: computeBasis(declaredTargets, prior.ownerNode),
            };
          } else {
            outcome = { missing: true };
          }
        } else {
          // Stored outcome was external/missing — keep as-is (re-resolution needs parsing).
          outcome = prior;
        }
      } else {
        // Unknown hint family — preserve the stored outcome rather than fabricate.
        outcome = o.outcome;
      }

      currentOutcomes.push({ fromFile: o.fromFile, line: o.line, hintKey: o.hintKey, outcome });
    }

    // 6. Rebuild the FingerprintInput and compare. grammarVersions is reused from
    //    the stored evidence: a grammar bump is out of v0 scope here (it would be
    //    a deterministic re-validation trigger handled by --approve, not by this
    //    parse-free path). computeFingerprint re-sorts internally, so order is moot.
    const current: FingerprintInput = {
      sources: sortedSources,
      relations: currentRelations,
      outcomes: currentOutcomes,
      grammarVersions: stored.evidence.grammarVersions,
      indexIdentity: currentIndexIdentity,
    };

    if (computeFingerprint(current) === stored.fingerprint) {
      if (stored.verdict === 'refused') {
        // Reconstruct the structured violations from the re-derived outcomes so
        // the refusal message can name each undeclared target and compute the
        // allowed relation types for it. Resolved outcomes carry the owner node;
        // verifyNodeDeps applies the same intra-node / ancestor exemptions the
        // pass used, so the reconstruction matches the recorded refusal.
        const resolvedDeps: ResolvedDep[] = [];
        for (const o of currentOutcomes) {
          if ('ownerNode' in o.outcome) {
            resolvedDeps.push({ fromFile: o.fromFile, line: o.line, ownerNode: o.outcome.ownerNode });
          }
        }
        const violations = verifyNodeDeps(nodeId, resolvedDeps, graphView);
        results.push({ nodeId, kind: 'refused', reason: stored.reason, violations });
      } else {
        results.push({ nodeId, kind: 'verified' });
      }
    } else {
      results.push({ nodeId, kind: 'unverified' });
    }
  }

  return results;
}
