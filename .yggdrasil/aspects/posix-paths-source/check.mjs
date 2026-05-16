import { ast } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    // Skip test files
    if (ast.inFile(file, '**/*.test.ts')) continue;

    // 1. Detect path.sep member access
    for (const node of ast.within(file.ast.rootNode, 'member_expression', { crossFunctions: true })) {
      const obj = node.childForFieldName('object');
      const prop = node.childForFieldName('property');
      if (obj && prop && obj.text === 'path' && prop.text === 'sep') {
        violations.push(
          ast.report(
            file,
            node,
            `'path.sep' detected — use '/' literal or split(/[\\\\/]/) to handle both separators without platform dependency`,
          ),
        );
      }
    }

    // 2. Detect backslash as path separator in string literals (not regex literals)
    for (const node of ast.within(file.ast.rootNode, 'string', { crossFunctions: true })) {
      for (const child of node.children) {
        if (child.type !== 'string_fragment') continue;
        const text = child.text;
        // Flag \\ (literal backslash in value) NOT followed by common regex replacement chars
        // Regex: \\ not followed by $ or & (regex replacements like \$&, \$1, etc.)
        if (/\\\\(?![$&\d])/.test(text)) {
          violations.push(
            ast.report(
              file,
              child,
              `backslash path separator '\\\\' in string literal — use '/' for POSIX paths`,
            ),
          );
          break; // one violation per string node
        }
      }
    }
  }
  return violations;
}
