import { ast } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const calls = file.ast.rootNode.descendantsOfType('call_expression');
    for (const callNode of calls) {
      const matched = ast.call(callNode, { object: 'fs', method: /Sync$/ });
      if (matched) {
        violations.push(ast.report(file, callNode, 'Use async fs APIs instead of sync (readFileSync, writeFileSync, etc.)'));
      }
    }
  }
  return violations;
}
