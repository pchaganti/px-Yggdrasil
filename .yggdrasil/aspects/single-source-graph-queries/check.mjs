import { ast } from '@chrisdudek/yg/ast';

// Reserved graph-query helper names. These live only under core/graph/.
// Engine files outside core/graph/ must import from there, not redefine.
const RESERVED_NAMES = new Set([
  'collectAncestors',
  'collectDescendants',
  'collectParticipatingFlows',
  'collectDependencyAncestors',
  'computeEffectiveAspects',
  'getAspectSource',
  'collectTrackedFiles',
]);

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    // The canonical module is the only allowed definition site.
    if (ast.inFile(file, '**/core/graph/**/*.ts')) continue;
    // Only engine files (under src/core/).
    if (!ast.inFile(file, '**/src/core/**/*.ts')) continue;

    // function_declaration form
    for (const node of ast.within(file.ast.rootNode, 'function_declaration', { crossFunctions: true })) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      if (RESERVED_NAMES.has(nameNode.text)) {
        violations.push(
          ast.report(
            file,
            node,
            `redefinition of reserved graph-query helper '${nameNode.text}' — import from core/graph instead`,
          ),
        );
      }
    }

    // const name = (...) => { ... } / function (...) { ... }
    for (const decl of ast.within(file.ast.rootNode, 'variable_declarator', { crossFunctions: true })) {
      const nameNode = decl.childForFieldName('name');
      const valueNode = decl.childForFieldName('value');
      if (!nameNode || !valueNode) continue;
      if (!RESERVED_NAMES.has(nameNode.text)) continue;
      if (
        valueNode.type === 'arrow_function' ||
        valueNode.type === 'function' ||
        valueNode.type === 'function_expression'
      ) {
        violations.push(
          ast.report(
            file,
            decl,
            `redefinition of reserved graph-query helper '${nameNode.text}' as arrow/function expression — import from core/graph instead`,
          ),
        );
      }
    }
  }
  return violations;
}
