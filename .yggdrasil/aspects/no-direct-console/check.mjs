import { ast } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    for (const node of ast.within(file.ast.rootNode, 'call_expression', { crossFunctions: true })) {
      const fn = node.childForFieldName('function');
      if (!fn) continue;
      if (fn.text.startsWith('console.')) {
        violations.push(
          ast.report(
            file,
            node,
            `direct ${fn.text}() call — engine output must use debugWrite() or go through formatters`,
          ),
        );
      }
    }
  }
  return violations;
}
