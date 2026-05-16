import { ast } from '@chrisdudek/yg/ast';

const FS_MODULES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    for (const imp of ast.imports(file.ast.rootNode)) {
      if (!FS_MODULES.has(imp.source)) continue;
      violations.push(
        ast.report(
          file,
          imp.node,
          `direct import from '${imp.source}' — route file-system calls through io/graph-fs.ts instead`,
        ),
      );
    }
  }
  return violations;
}
