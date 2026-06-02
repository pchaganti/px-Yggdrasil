import { report } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    for (const child of file.ast.rootNode.children) {
      if (child.type !== 'expression_statement') continue;
      const expr = child.childForFieldName('expression') ?? child.children[0];
      if (!expr) continue;
      if (expr.type === 'call_expression' || expr.type === 'await_expression') {
        violations.push(
          report(
            file,
            expr,
            `top-level call at module scope — utility modules must not execute side effects on import`,
          ),
        );
      }
    }
  }
  return violations;
}
