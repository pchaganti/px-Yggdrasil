// aspect-status defaults pass — a helper sub-routine called by the v5
// migration (`to-5.0.0.ts`). This file is NOT itself a migration: it does
// not own version bookkeeping, does not call `updateConfigVersion`, and does
// not return a `MigrationResult`. The owning migration (`migrateTo50`) calls
// this function and folds any warnings it emits into the migration-level
// `warnings` array; the runner then withholds the version bump if any
// warnings were accumulated. Migrations under this directory are named
// `to-X.Y.Z.ts`; this file is intentionally a helper, not a migration entry.
//
// v5 introduces three-level aspect status (draft/advisory/enforced) and
// 'strictest' as the default propagation mode on implies edges. Two patterns
// in pre-5.0 graphs are now potentially surprising and must be surfaced —
// without rewriting any files:
//
//   1. Escalation: aspect A (default enforced) implies aspect B (default
//      advisory or draft) via a bare string or `{id: B}` (no
//      status_inherit). Under strictest, B will run as enforced when
//      reached via A.
//
//   2. Downgrade: an attach site explicitly sets a status lower than the
//      cascading anchor (max of all OTHER channels + aspect-default).
//
// Either pattern emits a warning that withholds the version bump.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const STATUS_RANK: Readonly<Record<string, number>> = {
  draft: 0,
  advisory: 1,
  enforced: 2,
};
type Status = 'draft' | 'advisory' | 'enforced';

interface AspectInfo {
  id: string;
  defaultStatus: Status;
  /** Implies edges with their per-edge status_inherit (undefined → strictest default). */
  implies: Array<{ id: string; statusInherit: string | undefined }>;
}

interface AttachSiteRaw {
  /** Origin label, e.g. "model/orders/yg-node.yaml", "yg-architecture.yaml (node_type: command)", "flows/checkout/yg-flow.yaml". */
  origin: string;
  /** Which broad channel this site contributes to. Used to compute cross-channel anchors. */
  channel: 'own' | 'arch-type' | 'flow' | 'port';
  /** Aspect id attached at this site. */
  aspectId: string;
  /** Explicit status declared on this site, undefined → no override (inherits aspect-default). */
  declared: Status | undefined;
}

function parseStatus(raw: unknown): Status | undefined {
  if (raw === 'draft' || raw === 'advisory' || raw === 'enforced') return raw;
  return undefined;
}

function parseAttachmentEntry(
  raw: unknown,
): { id: string; status: Status | undefined; statusInherit: string | undefined } | undefined {
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id === '' ? undefined : { id, status: undefined, statusInherit: undefined };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (id === '') return undefined;
  const statusInherit =
    typeof obj.status_inherit === 'string' ? obj.status_inherit : undefined;
  return { id, status: parseStatus(obj.status), statusInherit };
}

async function walkGraphDirs(
  rootDir: string,
  relPath: string,
  yamlName: string,
  visit: (relativeId: string, yamlPath: string) => Promise<void>,
): Promise<void> {
  const dir = path.join(rootDir, relPath);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const yamlPath = path.join(dir, yamlName);
  const relativeId = relPath.replace(/\\/g, '/');
  try {
    await readFile(yamlPath, 'utf-8');
    if (relativeId !== '') await visit(relativeId, yamlPath);
  } catch {
    // not a node/aspect dir at this level
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    await walkGraphDirs(rootDir, path.join(relPath, entry.name), yamlName, visit);
  }
}

async function loadAspects(yggRoot: string): Promise<Map<string, AspectInfo>> {
  const result = new Map<string, AspectInfo>();
  const aspectsDir = path.join(yggRoot, 'aspects');
  await walkGraphDirs(aspectsDir, '', 'yg-aspect.yaml', async (aspectId, yamlPath) => {
    let raw: Record<string, unknown>;
    try {
      const content = await readFile(yamlPath, 'utf-8');
      raw = parseYaml(content) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!raw || typeof raw !== 'object') return;

    const defaultStatus = parseStatus(raw.status) ?? 'enforced';
    const implies: Array<{ id: string; statusInherit: string | undefined }> = [];
    if (Array.isArray(raw.implies)) {
      for (const entry of raw.implies) {
        const parsed = parseAttachmentEntry(entry);
        if (parsed) implies.push({ id: parsed.id, statusInherit: parsed.statusInherit });
      }
    }
    result.set(aspectId, { id: aspectId, defaultStatus, implies });
  });
  return result;
}

async function loadAttachSitesAndNodeAspects(
  yggRoot: string,
): Promise<{ sites: AttachSiteRaw[]; nodeAspectCounts: Map<string, number> }> {
  const sites: AttachSiteRaw[] = [];
  const nodeAspectCounts = new Map<string, number>();
  const bump = (id: string): void => {
    nodeAspectCounts.set(id, (nodeAspectCounts.get(id) ?? 0) + 1);
  };

  // Nodes — channel 1 (own) and channel 6 (ports).
  const modelDir = path.join(yggRoot, 'model');
  await walkGraphDirs(modelDir, '', 'yg-node.yaml', async (nodePath, yamlPath) => {
    let raw: Record<string, unknown>;
    try {
      const content = await readFile(yamlPath, 'utf-8');
      raw = parseYaml(content) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!raw || typeof raw !== 'object') return;
    const originBase = `model/${nodePath}/yg-node.yaml`;
    if (Array.isArray(raw.aspects)) {
      for (const entry of raw.aspects) {
        const parsed = parseAttachmentEntry(entry);
        if (!parsed) continue;
        sites.push({
          origin: originBase,
          channel: 'own',
          aspectId: parsed.id,
          declared: parsed.status,
        });
        bump(parsed.id);
      }
    }
    if (raw.ports && typeof raw.ports === 'object' && !Array.isArray(raw.ports)) {
      for (const [portName, portVal] of Object.entries(raw.ports as Record<string, unknown>)) {
        if (!portVal || typeof portVal !== 'object' || Array.isArray(portVal)) continue;
        const port = portVal as Record<string, unknown>;
        if (!Array.isArray(port.aspects)) continue;
        for (const entry of port.aspects) {
          const parsed = parseAttachmentEntry(entry);
          if (!parsed) continue;
          sites.push({
            origin: `${originBase} (port: ${portName})`,
            channel: 'port',
            aspectId: parsed.id,
            declared: parsed.status,
          });
        }
      }
    }
  });

  // Architecture — channel 3 (own type default).
  const archPath = path.join(yggRoot, 'yg-architecture.yaml');
  let nodeTypes: Record<string, unknown> | undefined;
  try {
    const archRaw = parseYaml(await readFile(archPath, 'utf-8')) as Record<string, unknown>;
    const nt = archRaw?.node_types;
    if (nt && typeof nt === 'object' && !Array.isArray(nt)) {
      nodeTypes = nt as Record<string, unknown>;
    }
  } catch {
    // missing or unparseable architecture — nothing to harvest
  }
  for (const [typeName, typeVal] of Object.entries(nodeTypes ?? {})) {
    if (!typeVal || typeof typeVal !== 'object' || Array.isArray(typeVal)) continue;
    const typeAspects = (typeVal as Record<string, unknown>).aspects;
    if (!Array.isArray(typeAspects)) continue;
    for (const entry of typeAspects) {
      const parsed = parseAttachmentEntry(entry);
      if (!parsed) continue;
      sites.push({
        origin: `yg-architecture.yaml (node_type: ${typeName})`,
        channel: 'arch-type',
        aspectId: parsed.id,
        declared: parsed.status,
      });
    }
  }

  // Flows — channel 5.
  const flowsDir = path.join(yggRoot, 'flows');
  let flowEntries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    flowEntries = await readdir(flowsDir, { withFileTypes: true });
  } catch {
    // missing flows directory — nothing to harvest
  }
  for (const fe of flowEntries) {
    if (!fe.isDirectory()) continue;
    const flowYaml = path.join(flowsDir, fe.name, 'yg-flow.yaml');
    let flowRaw: Record<string, unknown>;
    try {
      const content = await readFile(flowYaml, 'utf-8');
      flowRaw = parseYaml(content) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!flowRaw || typeof flowRaw !== 'object') continue;
    if (!Array.isArray(flowRaw.aspects)) continue;
    for (const entry of flowRaw.aspects) {
      const parsed = parseAttachmentEntry(entry);
      if (!parsed) continue;
      sites.push({
        origin: `flows/${fe.name}/yg-flow.yaml`,
        channel: 'flow',
        aspectId: parsed.id,
        declared: parsed.status,
      });
    }
  }

  return { sites, nodeAspectCounts };
}

/**
 * Inspect-only migration pass for v5 aspect status defaults. Appends to
 * `warnings` when patterns from the leading comment are detected. Never
 * writes to source files; the migrator runner withholds the version bump
 * whenever this (or any earlier pass) added entries to `warnings`.
 */
export async function addAspectStatusDefaults(
  yggRoot: string,
  warnings: string[],
): Promise<void> {
  const aspects = await loadAspects(yggRoot);
  if (aspects.size === 0) return;

  const { sites, nodeAspectCounts } = await loadAttachSitesAndNodeAspects(yggRoot);

  // 1. Escalation — implier A (default enforced) implies B whose own
  //    default is lower, without status_inherit on the edge.
  for (const implier of aspects.values()) {
    if (implier.defaultStatus !== 'enforced') continue;
    for (const edge of implier.implies) {
      if (edge.statusInherit !== undefined) continue; // explicit choice — no warning
      const implied = aspects.get(edge.id);
      if (!implied) continue;
      if (STATUS_RANK[implied.defaultStatus] >= STATUS_RANK['enforced']) continue;
      const count = nodeAspectCounts.get(implier.id) ?? 0;
      warnings.push(
        `aspect-status-migration-escalation: aspect '${implier.id}' (default enforced) implies '${implied.id}' (default ${implied.defaultStatus}) ` +
          `without status_inherit. ` +
          `WHY: v5 propagates status with the new 'strictest' default — '${implied.id}' will now run as enforced when reached via '${implier.id}'. ` +
          `Impact: '${implier.id}' is attached on ${count} node aspect entr${count === 1 ? 'y' : 'ies'} (rough estimate; flow/port attaches add to that). ` +
          `NEXT: confirm the escalation is intended (leave the edge as-is), or set 'status_inherit: own-default' on the implies entry for '${implied.id}' ` +
          `in aspects/${implier.id}/yg-aspect.yaml to preserve the v4 behavior. Then re-run \`yg init --upgrade\`.`,
      );
    }
  }

  // 2. Downgrade — explicit status at a site is lower than the
  //    cross-channel anchor (max of all OTHER sites + aspect-default).
  //    Group sites by aspect id, evaluate each explicit one in turn.
  const byAspect = new Map<string, AttachSiteRaw[]>();
  for (const s of sites) {
    const arr = byAspect.get(s.aspectId);
    if (arr) arr.push(s);
    else byAspect.set(s.aspectId, [s]);
  }
  for (const [aspectId, group] of byAspect) {
    const aspectDefault: Status = aspects.get(aspectId)?.defaultStatus ?? 'enforced';
    for (const site of group) {
      if (site.declared === undefined) continue;
      let anchorRank = STATUS_RANK[aspectDefault];
      for (const other of group) {
        if (other === site) continue;
        const otherStatus: Status = other.declared ?? aspectDefault;
        if (STATUS_RANK[otherStatus] > anchorRank) anchorRank = STATUS_RANK[otherStatus];
      }
      if (STATUS_RANK[site.declared] < anchorRank) {
        const anchorName: Status =
          anchorRank === STATUS_RANK.enforced
            ? 'enforced'
            : anchorRank === STATUS_RANK.advisory
              ? 'advisory'
              : 'draft';
        warnings.push(
          `aspect-status-migration-downgrade: ${site.origin} declares status '${site.declared}' for aspect '${aspectId}' ` +
            `but the cascading anchor (aspect-default and other channels) is '${anchorName}'. ` +
            `WHY: v5 forbids an attach site from silently weakening (downgrading) a status that already cascades onto the node. ` +
            `NEXT: either remove the explicit status (let the cascade win), or raise the aspect-default / other cascading sources if you intend ` +
            `to relax enforcement everywhere. Then re-run \`yg init --upgrade\`.`,
        );
      }
    }
  }
}
