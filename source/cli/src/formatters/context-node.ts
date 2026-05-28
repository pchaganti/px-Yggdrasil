export interface NodeContextData {
  path: string;
  name: string;
  type: string;
  description?: string;
  sourceFiles: string[];
  aspects: NodeContextAspect[];
  flows: NodeContextFlow[];
  dependencies: NodeContextDep[];
  dependentCount: number;
  dependentPaths?: string[]; // populated when <= 5 dependents (plain list)
  parentPath?: string;
  parentType?: string;
  parentReadPath?: string;
}

export interface NodeContextAspect {
  id: string;
  name: string;
  description: string;
  source: string;
  verifiedAgainst: string;
  implies?: string[];
  references?: Array<{ path: string; description?: string }>;
  /** Effective enforcement status on this node. Task 18 consumers render this. */
  status?: import('../model/graph.js').AspectStatus;
}

export interface NodeContextFlow {
  id: string;
  name: string;
  description: string;
  readPath: string;
}

export interface NodeContextDep {
  path: string;
  relation: string;
  description?: string;
  readPath?: string;
  consumes?: string[];
  portAspects?: Array<{ aspectId: string; verifiedAgainst: string }>;
}

import { truncateDescription } from './truncate.js';

function posixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function formatNodeContext(data: NodeContextData): string {
  const lines: string[] = [];

  // Header
  const desc = data.description ? ` — ${data.description}` : '';
  lines.push(`${posixPath(data.path)}${desc} (${data.type})`);
  lines.push('');

  // Source files
  lines.push(`Source files (${data.sourceFiles.length}):`);
  for (const f of data.sourceFiles) {
    lines.push(`  ${posixPath(f)}`);
  }
  lines.push('');

  // Aspects
  if (data.aspects.length > 0) {
    lines.push(`Must satisfy (${data.aspects.length} aspect${data.aspects.length === 1 ? '' : 's'}):`);
    lines.push('');
    for (const aspect of data.aspects) {
      const status = aspect.status ?? 'enforced';
      lines.push(`  ${aspect.id} [${status}] — ${aspect.description}`);
      lines.push(`    Source: ${posixPath(aspect.source)}`);
      if (status === 'draft') {
        lines.push('    (reviewer skipped; aspect is draft)');
        if (aspect.implies && aspect.implies.length > 0) {
          lines.push(`    Implies: ${aspect.implies.join(', ')}`);
        }
        lines.push('');
        continue;
      }
      lines.push(`    read: ${posixPath(aspect.verifiedAgainst)}`);
      if (aspect.references) {
        for (const ref of aspect.references) {
          if (ref.description && ref.description.length > 0) {
            lines.push(`    read: ${posixPath(ref.path)} — ${truncateDescription(ref.description)}`);
          } else {
            lines.push(`    read: ${posixPath(ref.path)}`);
          }
        }
      }
      if (aspect.implies && aspect.implies.length > 0) {
        lines.push(`    Implies: ${aspect.implies.join(', ')}`);
      }
      lines.push('');
    }
  }

  // Flows
  if (data.flows.length > 0) {
    lines.push(`Participates in (${data.flows.length} flow${data.flows.length === 1 ? '' : 's'}):`);
    for (const flow of data.flows) {
      lines.push(`  ${flow.id} — ${flow.description}`);
      lines.push(`    read: ${posixPath(flow.readPath)}`);
    }
    lines.push('');
  }

  // Dependencies
  if (data.dependencies.length > 0) {
    lines.push(`Dependencies (${data.dependencies.length}):`);
    for (const dep of data.dependencies) {
      const depDesc = dep.description ? ` — ${dep.description}` : '';
      const consumes = dep.consumes ? ` — consumes: ${dep.consumes.join(', ')}` : '';
      lines.push(`  ${posixPath(dep.path)} (${dep.relation})${depDesc}${consumes}`);
      if (dep.portAspects && dep.portAspects.length > 0) {
        for (const pa of dep.portAspects) {
          lines.push(`    Required: ${pa.aspectId}`);
        }
      }
      if (dep.readPath) {
        lines.push(`    read: ${posixPath(dep.readPath)}`);
      }
    }
    lines.push('');
  }

  // Dependents with consequence framing
  if (data.dependentCount > 0) {
    lines.push(`Dependents (${data.dependentCount}):`);
    if (data.dependentCount >= 16) {
      lines.push(`  HIGH blast radius — changes cascade to ${data.dependentCount} nodes.`);
      lines.push(`  Strongly recommended: yg impact --node ${posixPath(data.path)}`);
    } else if (data.dependentCount >= 6) {
      lines.push(`  Moderate blast radius — changes trigger cascade review on ${data.dependentCount} nodes.`);
      lines.push(`  Run: yg impact --node ${posixPath(data.path)}`);
    } else {
      // 1-5: plain list of dependent node paths
      for (const dep of data.dependentPaths ?? []) {
        lines.push(`  ${posixPath(dep)}`);
      }
      lines.push(`  Run: yg impact --node ${posixPath(data.path)}`);
    }
    lines.push('');
  }

  // Parent
  if (data.parentPath) {
    lines.push(`Parent: ${posixPath(data.parentPath)} (${data.parentType ?? 'module'})`);
    if (data.parentReadPath) {
      lines.push(`  read: ${posixPath(data.parentReadPath)}`);
    }
    lines.push('');
  }

  // Workflow footer
  lines.push(`After modifying source files in this node: run yg check, then yg approve --node ${posixPath(data.path)}`);
  lines.push('');

  return lines.join('\n');
}
