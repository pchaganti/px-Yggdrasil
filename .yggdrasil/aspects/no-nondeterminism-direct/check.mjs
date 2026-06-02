import { walk, report, inFile } from '@chrisdudek/yg/ast';

// Identifiers that represent non-deterministic runtime state
const NONDETERMINISM_CALLS = new Set(['Date.now', 'Math.random']);

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    // Only check engine files (core/)
    if (!inFile(file, { glob: '**/src/core/**/*.ts' })) continue;

    walk(file.ast.rootNode, (node) => {
      // Catch Date.now() and Math.random() — member expressions inside call_expression
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        if (fn && fn.type === 'member_expression') {
          const obj = fn.childForFieldName('object');
          const prop = fn.childForFieldName('property');
          if (obj && prop) {
            const key = `${obj.text}.${prop.text}`;
            if (NONDETERMINISM_CALLS.has(key)) {
              violations.push(
                report(
                  file,
                  node,
                  `non-deterministic call '${key}()' — engine must not access runtime state directly; inject via parameter`,
                ),
              );
            }
          }
        }
        return; // don't descend into children — avoids double-reporting member_expression below
      }

      // Catch process.env member access (not a call, so check member_expression separately)
      if (node.type === 'member_expression') {
        const obj = node.childForFieldName('object');
        if (!obj || obj.text !== 'process') return;
        const prop = node.childForFieldName('property');
        if (!prop || prop.text !== 'env') return;
        // Only flag if this member_expression is not inside a call_expression already reported
        violations.push(
          report(
            file,
            node,
            `direct 'process.env' access — engine must receive environment values as injected parameters`,
          ),
        );
      }
    });
  }
  return violations;
}
