import type { Node } from 'web-tree-sitter';
import type { ExportedDecl } from './types.js';
import { nameOf } from './name.js';

type ExportKind = ExportedDecl['kind'];

/**
 * Maps an inner declaration node type to an export kind.
 * Returns null for unrecognised node types.
 */
function kindFromDecl(decl: Node): ExportKind | null {
  switch (decl.type) {
    case 'class_declaration':
      return 'class';
    // `export default class {}` — anonymous class node type is just 'class'
    case 'class':
      return 'class';
    case 'function_declaration':
    case 'function_signature':
      return 'function';
    // `export default function() {}` — anonymous function expression
    case 'function_expression':
      return 'function';
    case 'type_alias_declaration':
      return 'type';
    case 'interface_declaration':
      return 'interface';
    case 'enum_declaration':
      return 'enum';
    case 'internal_module':
    case 'module':
      return 'namespace';
    default:
      return null;
  }
}

/**
 * Resolves 'const' or 'let' from a lexical_declaration node.
 */
function lexicalKind(decl: Node): 'const' | 'let' {
  for (const child of decl.children) {
    if (child.type === 'const') return 'const';
    if (child.type === 'let') return 'let';
  }
  return 'const'; // fallback — should never happen for valid TS
}

/**
 * Returns all top-level export declarations in the given AST root node.
 *
 * Covers:
 *   - named exports:   export class / function / const / let / type / interface / enum / namespace
 *   - default exports: export default class / function (named or anonymous)
 *   - re-exports:      export { x } from "…" and export * from "…"
 */
export function exports(root: Node): ExportedDecl[] {
  const result: ExportedDecl[] = [];

  for (const exportNode of root.descendantsOfType('export_statement')) {
    const isDefault = exportNode.children.some((c) => c.type === 'default');

    // Re-export: has a 'string' child (the module specifier after `from`)
    const hasSource = exportNode.children.some((c) => c.type === 'string');
    if (hasSource) {
      result.push({
        node: exportNode,
        exportNode,
        name: null,
        isDefault: false,
        isReExport: true,
        kind: 'reexport',
      });
      continue;
    }

    // Find the inner declaration node (first named child that is not export_clause)
    const inner = exportNode.namedChildren.find(
      (c) => c.type !== 'export_clause',
    );

    if (!inner) continue;

    // lexical_declaration (const / let)
    if (inner.type === 'lexical_declaration') {
      const kind = lexicalKind(inner);
      // Name comes from the first variable_declarator
      const declarator = inner.namedChildren.find(
        (c) => c.type === 'variable_declarator',
      );
      const name = declarator ? (declarator.childForFieldName('name')?.text ?? null) : null;
      result.push({
        node: inner,
        exportNode,
        name,
        isDefault,
        isReExport: false,
        kind,
      });
      continue;
    }

    const kind = kindFromDecl(inner);
    if (!kind) continue;

    const name = nameOf(inner);

    result.push({
      node: inner,
      exportNode,
      name,
      isDefault,
      isReExport: false,
      kind,
    });
  }

  return result;
}
