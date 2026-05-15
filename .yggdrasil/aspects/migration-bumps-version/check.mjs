import { ast } from '@chrisdudek/yg/ast';
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
    for (const node of ast.within(file.ast.rootNode, 'string', { crossFunctions: true })) {
      // tree-sitter: string node children include the quotes and the string_fragment
      const fragment = node.children.find((c) => c.type === 'string_fragment');
      if (fragment) stringLiterals.push(fragment.text);
    }
    // Also collect template string literals
    for (const node of ast.within(file.ast.rootNode, 'template_string', { crossFunctions: true })) {
      stringLiterals.push(node.text.slice(1, -1)); // strip backticks
    }

    const hasVersion = stringLiterals.some((s) => s.includes(expectedVersion));
    if (!hasVersion) {
      violations.push(
        ast.report(
          file,
          file.ast.rootNode,
          `migration file ${base}.ts does not reference its target version "${expectedVersion}" as a string literal`,
        ),
      );
    }
  }
  return violations;
}
