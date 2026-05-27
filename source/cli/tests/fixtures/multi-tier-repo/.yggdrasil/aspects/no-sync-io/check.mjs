// Fixture check — detects fs.*Sync calls without external imports so the test
// fixture works from any temp directory (no node_modules needed).
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    for (const node of walkCallExpressions(file.ast.rootNode)) {
      const fn = node.childForFieldName('function');
      if (fn?.type !== 'member_expression') continue;
      const obj = fn.childForFieldName('object');
      const prop = fn.childForFieldName('property');
      if (obj?.text === 'fs' && /Sync$/.test(prop?.text ?? '')) {
        violations.push({ file: file.path, line: node.startPosition.row + 1, message: `fs.${prop.text} is synchronous — use async equivalent` });
      }
    }
  }
  return violations;
}

function* walkCallExpressions(node) {
  if (node.type === 'call_expression') yield node;
  for (let i = 0; i < node.childCount; i++) yield* walkCallExpressions(node.child(i));
}
