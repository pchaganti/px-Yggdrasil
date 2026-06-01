import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Graph, GraphNode } from '../../model/graph.js';
import type {
  DriftCategory,
  DriftNodeState,
  DriftIdentity,
  AspectIdentity,
  TrackedFileLayer,
} from '../../model/drift.js';
import { normalizeMappingPaths } from '../../io/paths.js';
import { collectAncestors } from './traversal.js';
import { computeEffectiveAspects } from './aspects.js';
import { selectTierForAspect } from '../tier-selection.js';
import { canonicalTierJson } from '../tier-identity.js';
import { toPosixPath } from '../../utils/posix.js';

export interface TrackedFile {
  path: string;           // relative to project root — REAL source/graph file
  category: DriftCategory;  // 'source' or 'graph'
  layer: TrackedFileLayer;  // which context layer brought this file into tracking
}

/** Real files tracked for drift PLUS the node's typed upstream identity. */
export interface TrackedContext {
  trackedFiles: TrackedFile[];
  identity: DriftIdentity;
}

const STRUCTURAL_RELATION_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);

const sha256Hex = (content: string): string => createHash('sha256').update(content).digest('hex');

/**
 * The identity of a node with nothing to track (no aspects, no relations, no
 * own subset of interest). Used for log-only baselines on mapping-less or
 * all-draft nodes where there is no upstream identity to fold. `ownSubset` is
 * the empty-string digest so the value is stable.
 */
export function emptyIdentity(): DriftIdentity {
  return { ownSubset: sha256Hex(''), ports: {}, aspects: {} };
}

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
 * Collect all files tracked by a node's context package, plus its typed
 * upstream identity. Mirrors the traversal of build-context but returns file
 * paths (not rendered content) and identity hashes instead of stuffing
 * synthetic string keys into the file list. This is the core function for
 * bidirectional drift detection.
 *
 * Synchronous — no I/O needed; all data comes from the loaded Graph.
 *
 * @param baseline Optional stored drift state for the node. When provided, the
 *   per-aspect `identity.aspects[id].checkTouched` map is carried into the
 *   returned identity (so drift fires when the set/content of files a
 *   deterministic aspect read changes), and CROSS-node touched paths are added
 *   as real 'check-touched' tracked files (they otherwise have no entry).
 */
export function collectTrackedFiles(node: GraphNode, graph: Graph, baseline?: DriftNodeState): TrackedContext {
  const seen = new Set<string>();
  const result: TrackedFile[] = [];

  // Compute the .yggdrasil prefix relative to project root.
  // graph.rootPath is absolute path to .yggdrasil/; project root is its parent.
  const projectRoot = path.dirname(graph.rootPath);
  const yggPrefix = path.relative(projectRoot, graph.rootPath);
  // Normalize to forward slashes for consistency
  const yggPrefixNormalized = toPosixPath(yggPrefix);

  const identityAspects: Record<string, AspectIdentity> = {};
  const identityPorts: Record<string, string> = {};

  function addFile(filePath: string, category: DriftCategory, layer: TrackedFileLayer): void {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    result.push({ path: filePath, category, layer });
  }

  function graphPath(...segments: string[]): string {
    return [yggPrefixNormalized, ...segments].join('/');
  }

  // 1. OWN — hash of aspect-relevant yg-node.yaml subset (type, aspects, relations, ports).
  // Only the subset is tracked — description-only changes do NOT trigger upstream drift.
  const ownSubsetHash = sha256Hex(JSON.stringify({
    type: node.meta.type,
    aspects: node.meta.aspects,
    relations: node.meta.relations,
    ports: node.meta.ports,
  }));

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
  // Owned = equals a mapping entry OR sits under a directory mapping entry. Exact-set
  // membership alone misses files under a directory mapping, misclassifying an own-file
  // edit as an upstream cascade. mappingPathsList is normalized (no trailing slash).
  const isOwnedByMapping = (p: string): boolean =>
    mappingPathsSet.has(p) || mappingPathsList.some((m) => p.startsWith(m + '/'));

  for (const aspectId of allAspectIds) {
    const aspect = graph.aspects.find(a => a.id === aspectId);
    if (!aspect) continue;
    // Hash the aspect's DEFINITION metadata EXCLUDING `status`, so an
    // advisory<->enforced flip is NOT drift — the canonical hash stays stable,
    // the verdict carries forward. A draft<->non-draft transition is still
    // surfaced via aspect-newly-active; a rule-content change still cascades via
    // the artifacts/references tracked below.
    const aspectIdentity: AspectIdentity = {
      meta: sha256Hex(JSON.stringify({
        id: aspect.id,
        name: aspect.name,
        description: aspect.description,
        reviewer: aspect.reviewer,
        implies: aspect.implies,
        impliesWhens: aspect.impliesWhens,
        impliesStatusInherit: aspect.impliesStatusInherit,
        when: aspect.when,
        references: aspect.references,
      })),
    };
    for (const art of aspect.artifacts) {
      addFile(graphPath('aspects', aspect.id, art.filename), 'graph', 'aspects');
    }
    // tier identity — drift when the resolved tier config changes. LLM only.
    if (aspect.reviewer.type === 'llm') {
      if (!graph.config.reviewer) {
        aspectIdentity.tier = sha256Hex('reviewer-config-missing');
      } else {
        const selResult = selectTierForAspect(aspect, graph.config.reviewer);
        aspectIdentity.tier = sha256Hex(
          selResult.ok ? canonicalTierJson(selResult.tier, selResult.tierName) : 'unresolved',
        );
      }
      // references — LLM only; skip paths owned by this node's mapping (the SOURCE
      // step claims them; prefix-aware for directory mappings).
      for (const ref of aspect.references ?? []) {
        if (isOwnedByMapping(ref.path)) continue;
        addFile(ref.path, 'graph', 'aspects');
      }
    }

    // Deterministic aspects carry NO tier — their identity is the meta + the
    // check.mjs artifact + the node's mapping files + the per-aspect
    // checkTouched set (folded below from the baseline).
    identityAspects[aspect.id] = aspectIdentity;
  }

  // check-touched: carry the baseline's per-aspect touched-file map into the
  // typed identity so drift fires when the set (or content) of files a
  // deterministic aspect read changes between runs. Only effective aspects on
  // this node receive a checkTouched entry (a prior entry for an aspect no
  // longer effective drops out — it is no longer part of the identity).
  //
  // A touched path in this node's OWN mapping is NOT added as a tracked file
  // (the SOURCE step tracks it under 'source' = source-drift). Only CROSS-node
  // touched paths (owned by a related node) are added as real 'check-touched'
  // tracked files — they otherwise have no tracking entry. The checkTouched map
  // in identity still summarizes the FULL set, so membership changes drift.
  if (baseline?.identity?.aspects) {
    for (const [aspectId, prior] of Object.entries(baseline.identity.aspects)) {
      const pathMap = prior.checkTouched;
      if (!pathMap) continue;
      const current = identityAspects[aspectId];
      if (!current) continue; // aspect no longer effective — drop its checkTouched
      for (const p of Object.keys(pathMap)) {
        if (isOwnedByMapping(p)) continue;
        addFile(p, 'source', 'check-touched');
      }
      current.checkTouched = pathMap;
    }
  }

  // 4. RELATIONAL-DEPS — structural relations (uses/calls/extends/implements)
  for (const relation of node.meta.relations ?? []) {
    if (!STRUCTURAL_RELATION_TYPES.has(relation.type)) continue;
    const target = graph.nodes.get(relation.target);
    if (!target) continue;

    // Track dependency yg-node.yaml only
    addFile(graphPath('model', target.path, 'yg-node.yaml'), 'graph', 'relational');

    // Track ports hash only (not full yg-node.yaml) — scoped cascade.
    // This ensures only port aspect changes cascade to dependents, not
    // unrelated target metadata changes (description, relations, mapping).
    if (target.meta.ports && Object.keys(target.meta.ports).length > 0) {
      identityPorts[target.path] = sha256Hex(JSON.stringify(target.meta.ports));
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

  return {
    trackedFiles: result,
    identity: { ownSubset: ownSubsetHash, ports: identityPorts, aspects: identityAspects },
  };
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
  const normalize = (p: string): string => toPosixPath(p.trim());
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


