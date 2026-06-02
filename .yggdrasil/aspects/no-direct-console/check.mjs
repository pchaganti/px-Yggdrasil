import { walk, report } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (!fn) return;
      if (fn.text.startsWith('console.')) {
        violations.push(
          report(
            file,
            node,
            `direct ${fn.text}() call — engine output must use debugWrite() or go through formatters`,
          ),
        );
      }
    });
  }
  return violations;
}
