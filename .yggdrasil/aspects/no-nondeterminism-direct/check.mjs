import { ast } from '@chrisdudek/yg/ast';

// Identifiers that represent non-deterministic runtime state
const NONDETERMINISM_CALLS = new Set(['Date.now', 'Math.random']);

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    // Only check engine files (core/)
    if (!ast.inFile(file, '**/src/core/**/*.ts')) continue;

    for (const node of ast.within(file.ast.rootNode, 'call_expression', { crossFunctions: true })) {
      const fn = node.childForFieldName('function');
      if (!fn) continue;

      // Catch Date.now() and Math.random() — member expressions
      if (fn.type === 'member_expression') {
        const obj = fn.childForFieldName('object');
        const prop = fn.childForFieldName('property');
        if (obj && prop) {
          const key = `${obj.text}.${prop.text}`;
          if (NONDETERMINISM_CALLS.has(key)) {
            violations.push(
              ast.report(
                file,
                node,
                `non-deterministic call '${key}()' — engine must not access runtime state directly; inject via parameter`,
              ),
            );
          }
        }
      }
    }

    // Catch process.env member access (not a call, so check member_expression separately)
    for (const node of ast.within(file.ast.rootNode, 'member_expression', { crossFunctions: true })) {
      const obj = node.childForFieldName('object');
      if (!obj) continue;
      if (obj.text !== 'process') continue;
      const prop = node.childForFieldName('property');
      if (!prop || prop.text !== 'env') continue;
      // Only flag if this member_expression is not inside a call_expression already reported
      violations.push(
        ast.report(
          file,
          node,
          `direct 'process.env' access — engine must receive environment values as injected parameters`,
        ),
      );
    }
  }
  return violations;
}
