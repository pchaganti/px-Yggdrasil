import { truncateDescription } from './truncate.js';
import { toPosixPath } from '../utils/posix.js';

export interface FileContextData {
  filePath: string;
  ownerPath?: string;
  ownerType?: string;
  aspects: FileContextAspect[];
  dependencies: FileContextDep[];
  dependentCount: number;
  candidates?: Array<{ nodePath: string; mappingPrefix: string }>;
}

export interface FileContextAspect {
  aspectId: string;
  aspectDescription: string;
  verifiedAgainst: string;
  source?: string; // for implied aspects
  references?: Array<{ path: string; description?: string }>;
  /** Effective enforcement status for this aspect on the owner node. Consumers render this. */
  status?: import('../model/graph.js').AspectStatus;
}

export interface FileContextDep {
  path: string;
  consumed: string[];
}

function posixPath(p: string): string {
  return toPosixPath(p);
}

export function formatFileContext(data: FileContextData): string {
  const lines: string[] = [];

  lines.push(posixPath(data.filePath));
  if (data.ownerPath) {
    lines.push(`  Owner: ${posixPath(data.ownerPath)} (${data.ownerType ?? 'unknown'})`);
  } else {
    lines.push('  Owner: unmapped');
    lines.push('');
    if (data.candidates && data.candidates.length > 0) {
      lines.push('  This file is not covered by any node.');
      lines.push('  Candidate nodes (by directory):');
      for (const c of data.candidates) {
        lines.push(`    ${posixPath(c.nodePath)} — ${posixPath(c.mappingPrefix)}`);
      }
      lines.push('  Add this file to a candidate node\'s mapping in yg-node.yaml, or create a new node.');
    }
    lines.push('');
    return lines.join('\n');
  }

  lines.push('');

  // Aspects
  if (data.aspects.length > 0) {
    lines.push('Must satisfy:');
    lines.push('');
    for (const aspect of data.aspects) {
      const status = aspect.status ?? 'enforced';
      lines.push(`  ${aspect.aspectId} [${status}] — ${aspect.aspectDescription}`);
      if (status === 'draft') {
        lines.push('    (reviewer skipped; aspect is draft)');
        if (aspect.source) {
          lines.push(`    Source: ${posixPath(aspect.source)}`);
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
      if (aspect.source) {
        lines.push(`    Source: ${posixPath(aspect.source)}`);
      }
      lines.push('');
    }
  }

  // Dependencies
  if (data.dependencies.length > 0) {
    lines.push('Dependencies consumed:');
    for (const dep of data.dependencies) {
      lines.push(`  ${posixPath(dep.path)} — ${dep.consumed.join(', ')}`);
    }
    lines.push('');
  }

  // Dependents
  if (data.dependentCount > 0) {
    lines.push(`Dependents: ${data.dependentCount} nodes — run yg impact --file ${posixPath(data.filePath)}`);
    lines.push('');
  }

  // Back-pointer
  lines.push(`Node context: run yg context --node ${posixPath(data.ownerPath!)}`);
  lines.push('');

  return lines.join('\n');
}
