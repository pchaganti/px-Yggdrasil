import path from 'node:path';
import type { Graph, GraphNode, AspectStatus } from '../../model/graph.js';
import { STATUS_ORDER } from '../../model/graph.js';
import type { ValidationIssue, IssueMessage } from '../../model/validation.js';
import { statPath, fileExistsSync } from '../../io/graph-fs.js';
import { computeEffectiveAspectStatuses, getAspectStatusSources, type AttachSource } from '../graph/aspects.js';
import { selectTierForAspect } from '../tier-selection.js';
import { aspectStatusDowngradeMessage } from '../../formatters/aspect-status-messages.js';
import { issueMsg } from './shared.js';

// --- aspect-rule-sources: content.md vs check.mjs mutual exclusion ---

export function checkAspectRuleSources(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);

  for (const aspect of graph.aspects) {
    const reviewer = aspect.reviewer.type;
    if (reviewer !== 'deterministic' && reviewer !== 'llm') continue; // covered by enum check

    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspect.id);
    const hasContentMd = fileExistsSync(path.join(aspectDir, 'content.md'));
    const hasCheckMjs = fileExistsSync(path.join(aspectDir, 'check.mjs'));

    if (hasContentMd && hasCheckMjs) {
      issues.push({
        severity: 'error',
        code: 'aspect-both-rule-sources',
        rule: 'aspect-rule-sources',
        ...issueMsg({
          what: `Aspect '${aspect.id}' has both content.md and check.mjs.`,
          why: `Exactly one rule source is allowed per aspect; the validator cannot infer intent.`,
          next: `Remove the file that does not match aspect's reviewer field (currently '${reviewer}').`,
        }),
      });
      // Also flag the wrong file type for the declared reviewer
      if (reviewer === 'llm') {
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'llm' but check.mjs is present.`,
            why: `LLM aspects must not ship check.mjs (that's the deterministic reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/check.mjs or change reviewer to 'deterministic'.`,
          }),
        });
      } else {
        // reviewer === 'deterministic'
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer '${reviewer}' but content.md is present.`,
            why: `Deterministic aspects must not ship content.md (that's the LLM reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/content.md or change reviewer to 'llm'.`,
          }),
        });
      }
      continue;
    }

    if (reviewer === 'llm') {
      if (!hasContentMd) {
        issues.push({
          severity: 'error',
          code: 'aspect-missing-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'llm' but content.md is missing.`,
            why: `LLM aspects need content.md as the rule definition the reviewer reads.`,
            next: `Create .yggdrasil/aspects/${aspect.id}/content.md describing the rule.`,
          }),
        });
      }
      if (hasCheckMjs) {
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer 'llm' but check.mjs is present.`,
            why: `LLM aspects must not ship check.mjs (that's the deterministic reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/check.mjs or change reviewer to 'deterministic'.`,
          }),
        });
      }
    } else {
      // reviewer === 'deterministic'
      if (!hasCheckMjs) {
        issues.push({
          severity: 'error',
          code: 'aspect-missing-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer '${reviewer}' but check.mjs is missing.`,
            why: `Deterministic aspects need check.mjs as the rule definition the structure runner executes.`,
            next: `Create .yggdrasil/aspects/${aspect.id}/check.mjs exporting a check function.`,
          }),
        });
      }
      if (hasContentMd) {
        issues.push({
          severity: 'error',
          code: 'aspect-unexpected-rule-source',
          rule: 'aspect-rule-sources',
          ...issueMsg({
            what: `Aspect '${aspect.id}' has reviewer '${reviewer}' but content.md is present.`,
            why: `Deterministic aspects must not ship content.md (that's the LLM reviewer's input).`,
            next: `Remove .yggdrasil/aspects/${aspect.id}/content.md or change reviewer to 'llm'.`,
          }),
        });
      }
    }
  }

  return issues;
}

// --- config-reviewer-missing: reviewer section must exist in yg-config.yaml ---

export function checkReviewerPresence(graph: Graph): ValidationIssue[] {
  if (graph.configError) return [];
  if (graph.config.reviewer) return [];
  const msgData: IssueMessage = {
    what: 'yg-config.yaml has no reviewer: section.',
    why: 'Every project must declare at least one reviewer tier — even AST-only projects need the section for future LLM aspects.',
    next: 'Add `reviewer: { tiers: { default-tier: { provider: ..., consensus: 1, config: { model: ... } } } }` to .yggdrasil/yg-config.yaml.',
  };
  return [{ code: 'config-reviewer-missing', severity: 'error', rule: 'config-reviewer-missing', ...issueMsg(msgData), messageData: msgData }];
}

// --- aspect-tier-unknown: aspect.reviewer.tier must reference a configured tier ---

export function checkAspectTierReferences(graph: Graph): ValidationIssue[] {
  if (graph.configError) return [];
  const issues: ValidationIssue[] = [];
  for (const aspect of graph.aspects) {
    if (aspect.reviewer.type !== 'llm') continue;
    const tier = aspect.reviewer.tier;
    if (!tier) continue;
    const tiers = graph.config.reviewer?.tiers ?? {};
    if (!tiers[tier]) {
      const tierNames = Object.keys(tiers);
      const msgData: IssueMessage = {
        what: `Aspect '${aspect.id}' references tier '${tier}' that does not exist in yg-config.yaml.`,
        why: 'Every tier reference must match a configured tier name under reviewer.tiers.',
        next: tierNames.length > 0
          ? `Use one of: ${tierNames.join(', ')}, or remove 'tier:' to use the default tier.`
          : `Add tier '${tier}' under reviewer.tiers in .yggdrasil/yg-config.yaml, or remove 'tier:' from the aspect.`,
      };
      issues.push({ code: 'aspect-tier-unknown', severity: 'error', rule: 'aspect-tier-unknown', ...issueMsg(msgData), messageData: msgData });
    }
  }
  return issues;
}

// --- aspect-reference-broken / aspect-reference-too-large / aspect-references-total-too-large ---

const DEFAULT_MAX_PER_FILE = 65536;   // 64 KiB
const DEFAULT_MAX_TOTAL = 262144;     // 256 KiB

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  return `${Math.round(n / 1024)} KiB`;
}

export async function checkAspectReferences(graph: Graph): Promise<ValidationIssue[]> {
  const projectRoot = path.dirname(graph.rootPath);
  const issues: ValidationIssue[] = [];
  for (const aspect of graph.aspects) {
    if (aspect.reviewer.type !== 'llm') continue;
    if (!aspect.references) continue;
    if (aspect.references.length === 0) {
      const msgData: IssueMessage = {
        what: `Aspect '${aspect.id}' declares 'references: []' (empty list).`,
        why: `empty list has no effect; this is likely a mid-edit state.`,
        next: `either populate the list, or remove the 'references:' line entirely.`,
      };
      issues.push({
        severity: 'warning',
        code: 'aspect-references-empty-array',
        rule: 'aspect-references-empty-array',
        ...issueMsg(msgData),
        messageData: msgData,
      });
      continue;
    }

    // Resolve tier caps; defaults used when tier selection fails or tier omits the field.
    let maxPerFile = DEFAULT_MAX_PER_FILE;
    let maxTotal = DEFAULT_MAX_TOTAL;
    let tierName: string | undefined;
    if (graph.config.reviewer) {
      const sel = selectTierForAspect(aspect, graph.config.reviewer);
      if (sel.ok) {
        tierName = sel.tierName;
        maxPerFile = sel.tier.references?.max_bytes_per_file ?? DEFAULT_MAX_PER_FILE;
        maxTotal = sel.tier.references?.max_total_bytes_per_aspect ?? DEFAULT_MAX_TOTAL;
      }
    }
    const tierLabel = tierName != null ? `for tier '${tierName}'` : 'for the resolved tier';

    let totalBytes = 0;
    for (const ref of aspect.references) {
      const absPath = path.join(projectRoot, ref.path);
      let stats: Awaited<ReturnType<typeof statPath>>;
      try {
        stats = await statPath(absPath);
      } catch {
        const msgData: IssueMessage = {
          what: `Aspect '${aspect.id}' references '${ref.path}' but the file does not exist.`,
          why: `reviewer cannot load missing reference files; approve would fail at runtime.`,
          next: `create the file, fix the path, or remove the reference entry in .yggdrasil/aspects/${aspect.id}/yg-aspect.yaml.`,
        };
        issues.push({
          severity: 'error',
          code: 'aspect-reference-broken',
          rule: 'aspect-reference-broken',
          ...issueMsg(msgData),
          messageData: msgData,
        });
        continue;
      }
      if (!stats.isFile()) {
        const msgData: IssueMessage = {
          what: `Aspect '${aspect.id}' references '${ref.path}' but the path resolves to a directory.`,
          why: `reference files must be regular files; directories cannot be loaded into the reviewer prompt.`,
          next: `point references entry to a specific file or remove the entry in .yggdrasil/aspects/${aspect.id}/yg-aspect.yaml.`,
        };
        issues.push({
          severity: 'error',
          code: 'aspect-reference-broken',
          rule: 'aspect-reference-broken',
          ...issueMsg(msgData),
          messageData: msgData,
        });
        continue;
      }
      const size = stats.size;
      if (size > maxPerFile) {
        const msgData: IssueMessage = {
          what: `Aspect '${aspect.id}' reference '${ref.path}' is ${formatBytes(size)}, exceeding the per-file limit of ${formatBytes(maxPerFile)} ${tierLabel}.`,
          why: `oversized references inflate prompt cost on every approve call across every node where this aspect is effective.`,
          next: `split the reference into smaller files, raise references.max_bytes_per_file on the aspect's tier in .yggdrasil/yg-config.yaml, or move the aspect to a higher-context tier.`,
        };
        issues.push({
          severity: 'error',
          code: 'aspect-reference-too-large',
          rule: 'aspect-reference-too-large',
          ...issueMsg(msgData),
          messageData: msgData,
        });
      }
      totalBytes += size;
    }
    if (totalBytes > maxTotal) {
      const msgData: IssueMessage = {
        what: `Aspect '${aspect.id}' total reference size is ${formatBytes(totalBytes)}, exceeding the per-aspect limit of ${formatBytes(maxTotal)} ${tierLabel}.`,
        why: `sum of reference bytes per aspect bounds the prompt cost across all nodes where this aspect is effective.`,
        next: `reduce reference sizes, drop low-value references, or raise references.max_total_bytes_per_aspect on the aspect's tier in .yggdrasil/yg-config.yaml.`,
      };
      issues.push({
        severity: 'error',
        code: 'aspect-references-total-too-large',
        rule: 'aspect-references-total-too-large',
        ...issueMsg(msgData),
        messageData: msgData,
      });
    }
  }
  return issues;
}

// --- aspect-status-downgrade: explicit attach-site status must not lower the cascading anchor ---

function sourceIsExplicit(source: AttachSource, node: GraphNode, aspectId: string, graph: Graph): boolean {
  switch (source.channel) {
    case 1: return aspectId in (node.meta.aspectStatus ?? {});
    case 2: {
      const ancestorPath = source.origin.replace(/^ancestor:/, '');
      const ancestor = graph.nodes.get(ancestorPath);
      return aspectId in (ancestor?.meta.aspectStatus ?? {});
    }
    case 3: return aspectId in (graph.architecture?.node_types[node.meta.type]?.aspectStatus ?? {});
    case 4: {
      const m = source.origin.match(/^ancestor-type:[^@]+@(.+)$/);
      const ancestorPath = m?.[1];
      if (!ancestorPath) return false;
      const ancestor = graph.nodes.get(ancestorPath);
      const typeDef = ancestor && graph.architecture?.node_types[ancestor.meta.type];
      return aspectId in (typeDef?.aspectStatus ?? {});
    }
    case 5: {
      const flowPath = source.origin.replace(/^flow:/, '');
      const flow = graph.flows.find(f => f.path === flowPath);
      return aspectId in (flow?.aspectStatus ?? {});
    }
    case 6: {
      const m = source.origin.match(/^port:([^@]+)@(.+)$/);
      if (!m) return false;
      const [, portName, targetPath] = m;
      const target = graph.nodes.get(targetPath);
      const port = target?.meta.ports?.[portName];
      return aspectId in (port?.aspectStatus ?? {});
    }
  }
}

export function checkAspectStatusDowngrade(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const node of graph.nodes.values()) {
    const statuses = computeEffectiveAspectStatuses(node, graph);
    for (const [aspectId] of statuses) {
      const sources = getAspectStatusSources(node, aspectId, graph);
      const aspectDef = graph.aspects.find(a => a.id === aspectId);
      const aspectDefault: AspectStatus = aspectDef?.status ?? 'enforced';

      for (const source of sources) {
        if (!sourceIsExplicit(source, node, aspectId, graph)) continue;

        const otherDeclared = sources.filter(s => s !== source).map(s => s.declared);
        const anchor: AspectStatus = otherDeclared.length === 0
          ? aspectDefault
          : otherDeclared.reduce<AspectStatus>(
              (acc, cur) => (STATUS_ORDER[cur] > STATUS_ORDER[acc] ? cur : acc),
              'draft',
            );

        if (STATUS_ORDER[source.declared] < STATUS_ORDER[anchor]) {
          const msgData = aspectStatusDowngradeMessage({
            nodePath: node.path,
            aspectId,
            declared: source.declared,
            anchor,
            origin: source.origin === `own:${node.path}` ? 'aspect-default and other channels' : source.origin,
          });
          issues.push({
            code: 'aspect-status-downgrade',
            severity: 'error',
            rule: 'aspect-status-downgrade',
            ...issueMsg(msgData),
            messageData: msgData,
            nodePath: node.path,
          });
        }
      }
    }
  }
  return issues;
}
