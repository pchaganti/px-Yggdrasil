import { walk, report } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'member_expression') return;
      const obj = fn.childForFieldName('object');
      const prop = fn.childForFieldName('property');
      if (!obj || !prop || obj.text !== 'process' || prop.text !== 'exit') return;
      const argsNode = node.childForFieldName('arguments');
      if (!argsNode) return;
      const numArg = argsNode.children.find((c) => c.type === 'number');
      if (!numArg) return;
      const code = numArg.text;
      if (code !== '0' && code !== '1') {
        violations.push(report(file, node, `process.exit(${code}) — command exit codes must be 0 or 1`));
      }
    });
  }
  return violations;
}
