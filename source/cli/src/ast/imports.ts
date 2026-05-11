import type { Node } from 'web-tree-sitter';
import type { ImportInfo } from './types.js';

/**
 * Strips surrounding quotes from a string literal node's text.
 * e.g. `"foo"` → `foo`, `'bar'` → `bar`
 */
function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

/**
 * Returns all imports in the given AST root node.
 *
 * Covers three patterns:
 *  1. ES import statements: import X / { a, b } / * as ns / type { A } from "…"
 *  2. CommonJS require calls: const x = require("…")
 *  3. Dynamic imports: await import("…") — surfaces as call_expression with import callee
 */
export function imports(root: Node): ImportInfo[] {
  const result: ImportInfo[] = [];

  // ── 1. ES import statements ────────────────────────────────────────────────
  for (const node of root.descendantsOfType('import_statement')) {
    // source: the 'string' named child directly on import_statement
    const sourceNode = node.children.find((c) => c.type === 'string');
    /* v8 ignore next 1 */
    if (!sourceNode) continue;
    const source = stripQuotes(sourceNode.text);

    // type-only: import_statement has a direct unnamed child of type 'type'
    const isTypeOnly = node.children.some((c) => c.type === 'type');

    // import_clause carries default/namespace/named binding
    const clause = node.children.find((c) => c.type === 'import_clause');

    let defaultName: string | null = null;
    let namespaceName: string | null = null;
    const names: string[] = [];

    if (clause) {
      for (const child of clause.children) {
        if (child.type === 'identifier') {
          // Default import: the bare identifier before a comma (or the only child)
          defaultName = child.text;
        } else if (child.type === 'namespace_import') {
          // import * as ns — the identifier inside namespace_import
          const id = child.children.find((c) => c.type === 'identifier');
          namespaceName = id?.text ?? null;
        } else if (child.type === 'named_imports') {
          // import { a, b } — collect import_specifier children
          for (const specifier of child.children) {
            if (specifier.type === 'import_specifier') {
              // The first identifier in the specifier is the local name
              // (or the original name if no alias)
              const id = specifier.children.find((c) => c.type === 'identifier');
              if (id) names.push(id.text);
            }
          }
        }
      }
    }

    result.push({
      node,
      source,
      kind: 'import',
      names,
      defaultName,
      namespaceName,
      isTypeOnly,
    });
  }

  // ── 2. require() calls ─────────────────────────────────────────────────────
  for (const node of root.descendantsOfType('call_expression')) {
    const callee = node.childForFieldName('function');
    if (callee?.text !== 'require') continue;

    const args = node.children.find((c) => c.type === 'arguments');
    /* v8 ignore next 1 */
    if (!args) continue;

    // First string argument
    const stringArg = args.children.find((c) => c.type === 'string');
    if (!stringArg) continue;

    const source = stripQuotes(stringArg.text);
    result.push({
      node,
      source,
      kind: 'require',
      names: [],
      defaultName: null,
      namespaceName: null,
      isTypeOnly: false,
    });
  }

  // ── 3. Dynamic imports: call_expression with callee type 'import' ──────────
  for (const node of root.descendantsOfType('call_expression')) {
    const callee = node.childForFieldName('function');
    if (callee?.type !== 'import') continue;

    const args = node.children.find((c) => c.type === 'arguments');
    /* v8 ignore next 1 */
    if (!args) continue;

    const stringArg = args.children.find((c) => c.type === 'string');
    if (!stringArg) continue;

    const source = stripQuotes(stringArg.text);
    result.push({
      node,
      source,
      kind: 'dynamic',
      names: [],
      defaultName: null,
      namespaceName: null,
      isTypeOnly: false,
    });
  }

  return result;
}
