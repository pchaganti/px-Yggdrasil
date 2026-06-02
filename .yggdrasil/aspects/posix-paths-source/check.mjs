import { walk, report, inFile } from '@chrisdudek/yg/ast';

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    // Skip test files
    if (inFile(file, { glob: '**/*.test.ts' })) continue;

    walk(file.ast.rootNode, (node) => {
      // 1. Detect path.sep member access
      if (node.type === 'member_expression') {
        const obj = node.childForFieldName('object');
        const prop = node.childForFieldName('property');
        if (obj && prop && obj.text === 'path' && prop.text === 'sep') {
          violations.push(
            report(
              file,
              node,
              `'path.sep' detected — use '/' literal or split(/[\\\\/]/) to handle both separators without platform dependency`,
            ),
          );
        }
        return false; // don't descend into member_expression children
      }

      // 2. Detect backslash as path separator in string literals (not regex literals)
      if (node.type === 'string') {
        for (const child of node.children) {
          if (child.type !== 'string_fragment') continue;
          const text = child.text;
          // Flag \\ (literal backslash in value) NOT followed by common regex replacement chars
          // Regex: \\ not followed by $ or & (regex replacements like \$&, \$1, etc.)
          if (/\\\\(?![$&\d])/.test(text)) {
            violations.push(
              report(
                file,
                child,
                `backslash path separator '\\\\' in string literal — use '/' for POSIX paths`,
              ),
            );
            break; // one violation per string node
          }
        }
        return false; // don't descend into string children further
      }
    });
  }
  return violations;
}
