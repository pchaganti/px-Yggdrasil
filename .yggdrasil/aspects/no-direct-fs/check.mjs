import { walk, report } from '@chrisdudek/yg/ast';

const FS_MODULES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'import_statement') return;
      const sourceNode = node.childForFieldName('source');
      if (!sourceNode) return;
      // strip surrounding quotes
      const source = sourceNode.text.slice(1, -1);
      if (!FS_MODULES.has(source)) return;
      violations.push(
        report(
          file,
          node,
          `direct import from '${source}' — route file-system calls through io/graph-fs.ts instead`,
        ),
      );
    });
  }
  return violations;
}
