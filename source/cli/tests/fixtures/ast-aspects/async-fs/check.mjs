import { report } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const calls = file.ast.rootNode.descendantsOfType('call_expression');
    for (const callNode of calls) {
      const callee = callNode.childForFieldName('function');
      if (!callee || callee.type !== 'member_expression') continue;
      const object = callee.childForFieldName('object');
      const property = callee.childForFieldName('property');
      if (!object || !property) continue;
      if (object.text === 'fs' && /Sync$/.test(property.text)) {
        violations.push(report(file, callNode, 'Use async fs APIs instead of sync (readFileSync, writeFileSync, etc.)'));
      }
    }
  }
  return violations;
}
