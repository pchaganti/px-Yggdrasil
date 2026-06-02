import { walk, report, inFile } from '@chrisdudek/yg/ast';

const REGISTER_PATTERN = /^register[A-Z]\w*Command$/;

/** Returns all exported function/const names matching REGISTER_PATTERN. */
function findRegisterExports(rootNode) {
  const found = [];
  walk(rootNode, (node) => {
    if (node.type !== 'export_statement') return;
    // Skip re-exports (export { x } from '...')
    const hasSource = node.children.some((c) => c.type === 'string');
    if (hasSource) return false;

    // export function registerXCommand(...) {}
    const funcDecl = node.namedChildren.find((c) => c.type === 'function_declaration');
    if (funcDecl) {
      const nameNode = funcDecl.childForFieldName('name');
      const name = nameNode?.text ?? null;
      if (name !== null && REGISTER_PATTERN.test(name)) {
        found.push({ node: funcDecl, exportNode: node, name });
      }
      return false;
    }

    // export const registerXCommand = ...
    const lexDecl = node.namedChildren.find((c) => c.type === 'lexical_declaration');
    if (lexDecl) {
      const declarator = lexDecl.namedChildren.find((c) => c.type === 'variable_declarator');
      const nameNode = declarator?.childForFieldName('name');
      const name = nameNode?.text ?? null;
      if (name !== null && REGISTER_PATTERN.test(name)) {
        found.push({ node: lexDecl, exportNode: node, name });
      }
      return false;
    }

    return false;
  });
  return found;
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!inFile(file, { glob: '**/src/cli/*.ts' })) continue;

    const registerExports = findRegisterExports(file.ast.rootNode);

    if (registerExports.length === 0) {
      violations.push(
        report(file, file.ast.rootNode, 'command file must export a register<Pascal>Command function'),
      );
    } else if (registerExports.length > 1) {
      violations.push(
        report(
          file,
          registerExports[1].node,
          `command file exports ${registerExports.length} register*Command functions — must export exactly one`,
        ),
      );
    }
  }
  return violations;
}
