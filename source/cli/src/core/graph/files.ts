import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Graph, GraphNode } from '../../model/graph.js';
import type { DriftCategory, DriftNodeState, TrackedFileLayer } from '../../model/drift.js';
import { normalizeMappingPaths } from '../../io/paths.js';
import { collectAncestors } from './traversal.js';
import { computeEffectiveAspects } from './aspects.js';
import { selectTierForAspect } from '../tier-selection.js';
import { canonicalTierJson } from '../tier-identity.js';

export interface TrackedFile {
  path: string;           // relative to project root
  category: DriftCategory;  // 'source' or 'graph'
  layer: TrackedFileLayer;  // which context layer brought this file into tracking
  syntheticHash?: string; // when present, use this hash instead of reading from disk
}

const STRUCTURAL_RELATION_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);

// Synthetic-key builders — the SINGLE source of truth for the per-aspect drift
// identity keys. These are produced here (in collectTrackedFiles via
// addSyntheticHash) and consumed by the cascade-attribution helpers in
// cli/approve.ts (filterAspectCascadeNodes, selectDriftedAspects). The produced
// STRINGS are part of every recorded baseline's drift hashes — changing them
// would invalidate all baselines and trigger a mass cascade. Keep byte-identical.
export const tierIdentityKey = (aspectId: string): string => `tier-identity:${aspectId}`;
export const checkTouchedKey = (aspectId: string): string => `check-touched:${aspectId}`;

/**
 * Repo-relative POSIX path to the .yggdrasil/ graph root (e.g. ".yggdrasil").
 *
 * The SINGLE source of truth for this prefix string. Both approveNode
 * (core/approve.ts, classifying changed files into source vs upstream) and
 * runLlmVerification (cli/approve.ts, lining up `aspects/<id>/` keys with the
 * drifted-subset filePaths) derive it. The produced string MUST stay
 * byte-identical across those sites or cascade attribution silently breaks —
 * keep this the only place it is computed.
 */
export function yggPrefixOf(graph: { rootPath: string }): string {
  return path.relative(path.dirname(graph.rootPath), graph.rootPath).split(/[\\/]/).join('/');
}

/**
 * Collect all files tracked by a node's context package.
 * Mirrors the traversal of build-context but returns file paths
 * instead of rendered content. This is the core function for
 * bidirectional drift detection.
 *
 * Synchronous — no I/O needed; all data comes from the loaded Graph.
 *
 * @param baseline Optional stored drift state for the node. When provided,
 *   checkTouchedFiles entries are included as 'check-touched'
 *   layer entries so drift fires when the set of files touched by a
 *   deterministic aspect changes between runs.
 */
export function collectTrackedFiles(node: GraphNode, graph: Graph, baseline?: DriftNodeState): TrackedFile[] {
  const seen = new Set<string>();
  const result: TrackedFile[] = [];

  // Compute the .yggdrasil prefix relative to project root.
  // graph.rootPath is absolute path to .yggdrasil/; project root is its parent.
  const projectRoot = path.dirname(graph.rootPath);
  const yggPrefix = path.relative(projectRoot, graph.rootPath);
  // Normalize to forward slashes for consistency
  const yggPrefixNormalized = yggPrefix.replace(/\\/g, '/').replace(/\/+$/, '');

  function addFile(filePath: string, category: DriftCategory, layer: TrackedFileLayer): void {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    result.push({ path: filePath, category, layer });
  }

  function addSyntheticHash(
    key: string,
    content: string,
    category: DriftCategory,
    layer: TrackedFileLayer,
  ): void {
    if (seen.has(key)) return;
    seen.add(key);
    const hash = createHash('sha256').update(content).digest('hex');
    result.push({ path: key, category, layer, syntheticHash: hash });
  }

  function graphPath(...segments: string[]): string {
    return [yggPrefixNormalized, ...segments].join('/');
  }

  // 1. OWN — synthetic hash of aspect-relevant yg-node.yaml subset (type, aspects, relations, ports)
  // Only the subset is tracked — description-only changes do NOT trigger upstream drift.
  const ownSubset = {
    type: node.meta.type,
    aspects: node.meta.aspects,
    relations: node.meta.relations,
    ports: node.meta.ports,
  };
  addSyntheticHash(
    `own-subset:${node.path}`,
    JSON.stringify(ownSubset),
    'graph',
    'hierarchy',
  );

  // 2. HIERARCHICAL — ancestors from root to parent (yg-node.yaml only)
  const ancestors = collectAncestors(node);
  for (const ancestor of ancestors) {
    addFile(graphPath('model', ancestor.path, 'yg-node.yaml'), 'graph', 'hierarchy');
  }

  // 3. ASPECTS — use computeEffectiveAspects for ALL aspects from all 7 channels
  const allAspectIds = computeEffectiveAspects(node, graph);

  // Compute mapping paths once — used by the SOURCE step and the ownership guards below.
  const mappingPathsList = normalizeMappingPaths(node.meta.mapping);
  const mappingPathsSet = new Set(mappingPathsList);
  // A path is owned by this node's mapping if it equals a mapping entry OR sits under a
  // directory mapping entry. Exact-set membership alone misses files under a directory
  // mapping, which would misclassify an own-file edit (a reference file or a
  // check-touched path under that directory) as an upstream cascade — bypassing the
  // source-drift classification and its log requirement. mappingPathsList is normalized
  // (no trailing slash), so `m + '/'` is the directory prefix.
  const isOwnedByMapping = (p: string): boolean =>
    mappingPathsSet.has(p) || mappingPathsList.some((m) => p.startsWith(m + '/'));

  for (const aspectId of allAspectIds) {
    const aspect = graph.aspects.find(a => a.id === aspectId);
    if (!aspect) continue;
    addFile(graphPath('aspects', aspect.id, 'yg-aspect.yaml'), 'graph', 'aspects');
    for (const art of aspect.artifacts) {
      addFile(graphPath('aspects', aspect.id, art.filename), 'graph', 'aspects');
    }
    // tier-identity synthetic hash — drift when the resolved tier config changes
    if (aspect.reviewer.type === 'llm') {
      if (!graph.config.reviewer) {
        addSyntheticHash(tierIdentityKey(aspect.id), 'reviewer-config-missing', 'graph', 'aspects');
      } else {
        const selResult = selectTierForAspect(aspect, graph.config.reviewer);
        addSyntheticHash(
          tierIdentityKey(aspect.id),
          selResult.ok ? canonicalTierJson(selResult.tier, selResult.tierName) : 'unresolved',
          'graph',
          'aspects',
        );
      }
      // references — LLM only; skip paths owned by this node's mapping (the SOURCE
      // step claims them). Prefix-aware so a reference under a directory mapping is
      // also recognized as own, not reclassified as upstream drift.
      for (const ref of aspect.references ?? []) {
        if (isOwnedByMapping(ref.path)) continue;
        addFile(ref.path, 'graph', 'aspects');
      }
    }

    // Deterministic (structure) aspects carry NO synthetic identity hash. Their
    // identity is fully file-tracked — the yg-aspect.yaml file hash (above), the
    // check.mjs artifact (above), the node's own mapping files, and the per-aspectId
    // checkTouchedFiles set hash (below). The former structure-identity key was a
    // CONSTANT (canonicalJson({ kind:'structure', language:null })) that added no drift
    // signal beyond the yg-aspect.yaml file hash, so it was removed.
  }

  // check-touched: inject entries from baseline's checkTouchedFiles so
  // drift fires when the set (or content) of files touched by a deterministic aspect changes.
  //
  // A touched path that is in this node's OWN mapping is skipped here: the SOURCE
  // step (below) already tracks it under the 'source' layer, which check.ts
  // classifies as source-drift. Adding it here first would label it
  // 'check-touched' (addFile dedups by path, first-writer-wins) and misreport
  // an own-file edit as an upstream cascade. Cross-node touched paths (owned by a
  // related node, not in this mapping) ARE added here as 'check-touched' — that
  // is the whole point: they otherwise have no tracking entry. The synthetic
  // per-aspect hash still summarizes the FULL set (own + cross) so a change to the
  // set membership drifts regardless of which paths are own vs cross.
  if (baseline?.checkTouchedFiles) {
    for (const [aspectId, pathMap] of Object.entries(baseline.checkTouchedFiles)) {
      for (const p of Object.keys(pathMap)) {
        if (isOwnedByMapping(p)) continue;
        addFile(p, 'source', 'check-touched');
      }
      const sorted = Object.keys(pathMap).sort();
      addSyntheticHash(
        checkTouchedKey(aspectId),
        sorted.join('\n'),
        'graph',
        'aspects',
      );
    }
  }

  // 4. RELATIONAL-DEPS — structural relations (uses/calls/extends/implements)
  for (const relation of node.meta.relations ?? []) {
    if (!STRUCTURAL_RELATION_TYPES.has(relation.type)) continue;
    const target = graph.nodes.get(relation.target);
    if (!target) continue;

    // Track dependency yg-node.yaml only
    addFile(graphPath('model', target.path, 'yg-node.yaml'), 'graph', 'relational');

    // Track ports hash only (not full yg-node.yaml) — scoped cascade
    // This ensures only port aspect changes cascade to dependents,
    // not unrelated target metadata changes (description, relations, mapping)
    if (target.meta.ports && Object.keys(target.meta.ports).length > 0) {
      const portsJson = JSON.stringify(target.meta.ports);
      addSyntheticHash(
        `port-aspects:${target.path}`,
        portsJson,
        'graph',
        'relational',
      );
    }

    // Track dependency ancestor yg-node.yaml files
    const depAncestors = collectAncestors(target);
    for (const ancestor of depAncestors) {
      addFile(graphPath('model', ancestor.path, 'yg-node.yaml'), 'graph', 'relational');
    }
  }

  // 4b. EVENT RELATIONS — emits/listens targets + their ancestors
  for (const relation of node.meta.relations ?? []) {
    if (relation.type !== 'emits' && relation.type !== 'listens') continue;
    const target = graph.nodes.get(relation.target);
    if (!target) continue;

    // Track dependency yg-node.yaml only
    addFile(graphPath('model', target.path, 'yg-node.yaml'), 'graph', 'relational');

    // Include target's ancestors (yg-node.yaml only)
    const eventAncestors = collectAncestors(target);
    for (const ancestor of eventAncestors) {
      addFile(graphPath('model', ancestor.path, 'yg-node.yaml'), 'graph', 'relational');
    }
  }

  // 5. SOURCE — files from mapping.paths
  for (const p of mappingPathsList) {
    addFile(p, 'source', 'source');
  }

  return result;
}

/**
 * Build a function resolving a hashed (possibly directory-expanded) file path to
 * the drift layer that brought it into tracking. Both `yg check` (classifyDrift)
 * and `yg approve` (approveNode) use this to tell a source change from an
 * upstream cascade.
 *
 * `collectTrackedFiles` may emit directory entries (e.g. `src/svc`) that the
 * hasher later expands into individual files (`src/svc/index.ts`); a directory
 * entry is matched by prefix. Paths are normalized (trim, backslash→slash, no
 * trailing slash) before comparison, so callers pass raw hashed keys.
 */
export function buildLayerResolver(
  trackedFiles: TrackedFile[],
): (filePath: string) => TrackedFileLayer | undefined {
  const normalize = (p: string): string => p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const fileLayerMap = new Map<string, TrackedFileLayer>();
  const dirPrefixes: Array<{ prefix: string; layer: TrackedFileLayer }> = [];
  for (const tf of trackedFiles) {
    const key = normalize(tf.path);
    if (!fileLayerMap.has(key)) fileLayerMap.set(key, tf.layer);
    dirPrefixes.push({ prefix: key + '/', layer: tf.layer });
  }
  return (filePath: string): TrackedFileLayer | undefined => {
    const normalized = normalize(filePath);
    const direct = fileLayerMap.get(normalized);
    if (direct) return direct;
    for (const { prefix, layer } of dirPrefixes) {
      if (normalized.startsWith(prefix)) return layer;
    }
    return undefined;
  };
}

