import type { Node } from 'web-tree-sitter';
import type { Decorator } from './types.js';

/**
 * Returns all decorators applied to the given node, in source order.
 *
 * Handles two grammar placements:
 *   - Bare class: decorators are named children of the class_declaration node itself.
 *   - Exported class: decorators are siblings under the parent export_statement.
 */
export function decoratorsOf(node: Node): Decorator[] {
  const decoratorNodes: Node[] = [];

  // Check node's own named children (bare class / method case)
  for (const child of node.namedChildren) {
    if (child.type === 'decorator') decoratorNodes.push(child);
  }

  // For exported classes: decorators live on the parent export_statement
  if (decoratorNodes.length === 0 && node.parent?.type === 'export_statement') {
    for (const sibling of node.parent.namedChildren) {
      if (sibling.type === 'decorator') decoratorNodes.push(sibling);
    }
  }

  return decoratorNodes.map(parseDecorator);
}

function parseDecorator(dec: Node): Decorator {
  // dec is a 'decorator' node
  // Its first named child is one of: identifier, call_expression, member_expression
  const inner = dec.namedChildren[0];

  if (!inner) {
    return { node: dec, name: '', args: [] };
  }

  if (inner.type === 'identifier') {
    // @Foo
    return { node: dec, name: inner.text, args: [] };
  }

  if (inner.type === 'call_expression') {
    // @Foo() or @Foo("a", b) or @ns.Foo(...)
    const fnNode = inner.childForFieldName('function');
    const name = extractName(fnNode);
    const argsNode = inner.namedChildren.find((c) => c.type === 'arguments');
    const args = argsNode ? argsNode.namedChildren : [];
    return { node: dec, name, args };
  }

  if (inner.type === 'member_expression') {
    // @ns.Foo
    const name = extractName(inner);
    return { node: dec, name, args: [] };
  }

  // Fallback: use text
  return { node: dec, name: inner.text, args: [] };
}

/**
 * Extracts the simple name from an identifier or member_expression node.
 * For member expressions (ns.Foo), returns the rightmost property identifier.
 */
function extractName(node: Node | null): string {
  if (!node) return '';

  if (node.type === 'identifier') {
    return node.text;
  }

  if (node.type === 'member_expression') {
    // property is the rightmost identifier after the last '.'
    const prop = node.childForFieldName('property');
    if (prop) return prop.text;
    // Fallback: split on dot
    const parts = node.text.split('.');
    return parts[parts.length - 1];
  }

  return node.text;
}
