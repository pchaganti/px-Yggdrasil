import { walk, report } from '@chrisdudek/yg/ast';
import path from 'node:path';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const base = path.basename(file.path, '.ts');
    // Only check files named to-X.Y.Z.ts
    const versionMatch = base.match(/^to-(\d+\.\d+\.\d+)$/);
    if (!versionMatch) continue;
    const expectedVersion = versionMatch[1];

    // Collect all string literal values in the file
    const stringLiterals = [];
    walk(file.ast.rootNode, (node) => {
      if (node.type === 'string') {
        // tree-sitter: string node children include the quotes and the string_fragment
        const fragment = node.children.find((c) => c.type === 'string_fragment');
        if (fragment) stringLiterals.push(fragment.text);
        return false; // don't descend into string children further
      }
      if (node.type === 'template_string') {
        stringLiterals.push(node.text.slice(1, -1)); // strip backticks
        return false; // don't descend into template string children further
      }
    });

    const hasVersion = stringLiterals.some((s) => s.includes(expectedVersion));
    if (!hasVersion) {
      violations.push(
        report(
          file,
          file.ast.rootNode,
          `migration file ${base}.ts does not reference its target version "${expectedVersion}" as a string literal`,
        ),
      );
    }
  }
  return violations;
}
