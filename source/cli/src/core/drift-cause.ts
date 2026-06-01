import path from 'node:path';
import type { Graph } from '../model/graph.js';
import type {
  DriftCategory,
  DriftIdentity,
  IdentityCause,
  TrackedFileLayer,
} from '../model/drift.js';
import { toPosixPath } from '../utils/posix.js';

// ============================================================
// Drift-cause helpers — pure functions that DIFF a node's typed
// upstream identity and DESCRIBE why a cascade fired. No I/O.
//
// Split out of check.ts / graph/files.ts so both parent nodes stay
// under the per-node reviewer budget. Everything here is a pure
// transform over already-loaded graph + identity data.
// ============================================================

/** Stable serialization of a checkTouched map (sorted) for change detection. */
function serializeCheckTouched(ct: Record<string, string> | undefined): string {
  if (!ct) return '';
  return Object.keys(ct).sort().map((k) => `${k}=${ct[k]}`).join(',');
}

/**
 * The TrackedFileLayer a given IdentityCause kind belongs to — mirrors the
 * layer the corresponding synthetic key used to carry, so cascade-cause
 * grouping/annotation stays consistent.
 */
export function identityCauseLayer(cause: IdentityCause): TrackedFileLayer {
  switch (cause.kind) {
    case 'ownSubset':
      return 'hierarchy';
    case 'port':
      return 'relational';
    case 'aspectMeta':
    case 'tier':
    case 'checkTouchedSet':
      return 'aspects';
  }
}

/**
 * A stable, human-facing display token for an identity-element change, used as
 * `CascadeCause.file` (a display string, NOT a path on disk). Distinct per
 * kind+entity so grouping by cause works.
 */
export function identityCauseToken(cause: IdentityCause): string {
  switch (cause.kind) {
    case 'ownSubset':
      return `node '${cause.nodePath}' own metadata`;
    case 'aspectMeta':
      return `aspect '${cause.aspectId}' definition`;
    case 'tier':
      return `aspect '${cause.aspectId}' reviewer tier`;
    case 'checkTouchedSet':
      return `aspect '${cause.aspectId}' read-set`;
    case 'port':
      return `dependency '${cause.targetPath}' port aspects`;
  }
}

/**
 * Diff a node's stored typed identity against its freshly-recomputed identity,
 * returning one IdentityCause per element that changed (added, removed, or
 * modified). The `checkTouchedSet` cause is emitted only when an aspect's
 * checkTouched MAP changed (membership or content) — its absence on both sides
 * is a no-op. This is the typed replacement for diffing synthetic `<kind>:<id>`
 * keys out of the flat file map.
 */
export function diffIdentity(nodePath: string, stored: DriftIdentity, current: DriftIdentity): IdentityCause[] {
  const causes: IdentityCause[] = [];

  if (stored.ownSubset !== current.ownSubset) {
    causes.push({ kind: 'ownSubset', nodePath });
  }

  // Ports: union of keys; differing (or added/removed) hash → port cause.
  for (const target of new Set([...Object.keys(stored.ports), ...Object.keys(current.ports)])) {
    if (stored.ports[target] !== current.ports[target]) {
      causes.push({ kind: 'port', targetPath: target });
    }
  }

  // Aspects: union of ids. Compare meta, tier, and checkTouched independently
  // so each maps to its own cause kind (matching the former per-key cascade).
  for (const id of new Set([...Object.keys(stored.aspects), ...Object.keys(current.aspects)])) {
    const s = stored.aspects[id];
    const c = current.aspects[id];
    const sMeta = s?.meta;
    const cMeta = c?.meta;
    if (sMeta !== cMeta) causes.push({ kind: 'aspectMeta', aspectId: id });
    const sTier = s?.tier;
    const cTier = c?.tier;
    if (sTier !== cTier) causes.push({ kind: 'tier', aspectId: id });
    if (serializeCheckTouched(s?.checkTouched) !== serializeCheckTouched(c?.checkTouched)) {
      causes.push({ kind: 'checkTouchedSet', aspectId: id });
    }
  }

  return causes;
}

/** Classify a tracked file as graph (.yggdrasil/) or source by its path prefix. */
export function categorizeFile(filePath: string, rootPath: string, projectRoot: string): DriftCategory {
  const yggPrefix = toPosixPath(path.relative(projectRoot, rootPath));
  const normalized = toPosixPath(filePath);
  return normalized.startsWith(yggPrefix) ? 'graph' : 'source';
}

/**
 * Describe why a REAL-FILE cascade fired AND provide the cause-specific review
 * instruction. Identity-element changes are described by describeIdentityCause;
 * this function only sees real files on disk (no synthetic keys).
 */
export function describeCascadeCause(filePath: string, layer: TrackedFileLayer, graph: Graph): string {
  const normalized = toPosixPath(filePath);
  const yggPrefix = toPosixPath(path.relative(path.dirname(graph.rootPath), graph.rootPath));
  const escPrefix = yggPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (layer === 'aspects') {
    const match = normalized.match(new RegExp(`${escPrefix}/aspects/([^/]+(?:/[^/]+)*)/`));
    if (match) {
      const aspectId = match[1];
      const filename = normalized.split('/').pop() ?? '';
      const label = filename === 'yg-aspect.yaml' ? '' : filename.replace('.md', '') + ' ';
      return `aspect '${aspectId}' ${label}changed\n       (${normalized})`;
    }
    // Path is not under .yggdrasil/aspects/ but is tracked under the 'aspects' layer —
    // this is a reference file declared in some aspect's `references:` list.
    const declaringAspects = graph.aspects
      .filter(a => a.reviewer.type === 'llm' && a.references?.some(r => r.path === normalized))
      .map(a => a.id);
    const declaredBy = declaringAspects.length === 0
      ? 'unknown aspect'
      : declaringAspects.length === 1
        ? `aspect '${declaringAspects[0]}'`
        : `aspects ${declaringAspects.map(id => `'${id}'`).join(', ')}`;
    return `reference file '${normalized}' (declared by ${declaredBy}) changed\n       (${normalized})`;
  }

  if (layer === 'hierarchy') {
    const match = normalized.match(new RegExp(`${escPrefix}/model/(.+)/[^/]+$`));
    const ancestorPath = match ? match[1] : 'unknown';
    return `parent node '${ancestorPath}' metadata changed\n       (${normalized})`;
  }

  if (layer === 'relational') {
    const match = normalized.match(new RegExp(`${escPrefix}/model/(.+)/([^/]+)$`));
    const depPath = match ? match[1] : 'unknown';
    const filename = match ? match[2] : '';
    const artifactLabel = filename === 'yg-node.yaml' ? 'metadata'
      : filename.replace('.md', '');
    return `dependency '${depPath}' ${artifactLabel} changed\n       (${normalized})`;
  }

  if (layer === 'check-touched') {
    // A real file (owned by another node) that a deterministic aspect's check reads.
    // The owning aspect's read-SET change is reported as a typed checkTouchedSet
    // identity cause; on a content edit we have only the path here.
    return `a file read by a deterministic aspect changed\n       (${normalized})`;
  }

  return `tracked file changed\n       (${normalized})`;
}

/**
 * Build a map: cross-node touched POSIX path → owning deterministic aspect
 * id(s), from the baseline's per-aspect checkTouched maps. A path may be read
 * by more than one aspect, hence an array.
 */
export function buildCheckTouchedOwnerMap(identity: DriftIdentity): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [aspectId, ai] of Object.entries(identity.aspects)) {
    if (!ai.checkTouched) continue;
    for (const p of Object.keys(ai.checkTouched)) {
      const norm = toPosixPath(p);
      const list = owners.get(norm) ?? [];
      list.push(aspectId);
      owners.set(norm, list);
    }
  }
  return owners;
}

/**
 * Describe a typed identity-element change (own metadata, aspect definition,
 * reviewer tier, deterministic read-set, dependency port aspects). The typed
 * replacement for the former synthetic-key string parsing.
 */
export function describeIdentityCause(cause: IdentityCause): string {
  const token = identityCauseToken(cause);
  switch (cause.kind) {
    case 'ownSubset':
      return `node '${cause.nodePath}' own metadata changed\n       (${token})`;
    case 'aspectMeta':
      return `the definition of aspect '${cause.aspectId}' changed\n       (${token})`;
    case 'tier':
      return `the resolved reviewer tier for aspect '${cause.aspectId}' changed\n       (${token})`;
    case 'checkTouchedSet':
      return `the set of files read by deterministic aspect '${cause.aspectId}' changed\n       (${token})`;
    case 'port':
      return `dependency '${cause.targetPath}' port aspects changed\n       (${token})`;
  }
}
