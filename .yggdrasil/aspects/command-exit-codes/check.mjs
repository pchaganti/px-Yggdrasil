import { ast } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    for (const node of ast.within(file.ast.rootNode, 'call_expression', { crossFunctions: true })) {
      const m = ast.call(node, { object: 'process', method: 'exit' });
      if (!m) continue;
      const argsNode = node.childForFieldName('arguments');
      if (!argsNode) continue;
      const numArg = argsNode.children.find((c) => c.type === 'number');
      if (!numArg) continue;
      const code = numArg.text;
      if (code !== '0' && code !== '1') {
        violations.push(ast.report(file, node, `process.exit(${code}) — command exit codes must be 0 or 1`));
      }
    }
  }
  return violations;
}
