import type { Node } from 'web-tree-sitter';

/**
 * Returns all JSX element nodes in the given AST subtree.
 *
 * Includes opening elements and self-closing elements;
 * excludes closing elements (jsx_closing_element).
 */
export function jsxElements(root: Node): Node[] {
  return [
    ...root.descendantsOfType('jsx_opening_element'),
    ...root.descendantsOfType('jsx_self_closing_element'),
  ];
}
