import type { PredicateTrace } from '../model/file-when.js';

/**
 * Render a predicate evaluation trace as an indented ✓/✗ tree.
 * Used in error messages (spec §7) to show which clauses passed/failed.
 */
export function renderTrace(trace: PredicateTrace, indent = ''): string {
  const lines: string[] = [];
  renderNode(trace, indent, lines);
  return lines.join('\n');
}

function renderNode(node: PredicateTrace, indent: string, lines: string[]): void {
  const mark = node.result ? '✓' : '✗';

  switch (node.kind) {
    case 'atom-path': {
      const verb = node.result ? 'matches' : 'does not match';
      const detail = node.detail ? ` (${node.detail})` : '';
      lines.push(`${indent}${mark} path ${verb} "${node.pattern}"${detail}`);
      break;
    }
    case 'atom-content': {
      const verb = node.result ? 'matches' : 'does not match';
      const detail = node.detail ? ` (${node.detail})` : '';
      lines.push(`${indent}${mark} content ${verb} "${node.pattern}"${detail}`);
      break;
    }
    case 'all_of': {
      lines.push(`${indent}${mark} all_of:`);
      for (const child of node.children) {
        renderNode(child, indent + '    ', lines);
      }
      break;
    }
    case 'any_of': {
      lines.push(`${indent}${mark} any_of:`);
      for (const child of node.children) {
        renderNode(child, indent + '    ', lines);
      }
      break;
    }
    case 'not': {
      lines.push(`${indent}${mark} not:`);
      renderNode(node.child, indent + '    ', lines);
      break;
    }
    case 'exempt': {
      lines.push(`${indent}${mark} exempt: ${node.reason}`);
      break;
    }
  }
}
