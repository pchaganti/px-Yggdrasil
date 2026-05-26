import type { Node } from 'web-tree-sitter';

export function walk(node: Node, visitor: (node: Node) => boolean | void): void {
  const result = visitor(node);
  if (result === false) return;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null) walk(child, visitor);
  }
}

export function closest(node: Node, types: string | string[]): Node | null {
  const set = typeof types === 'string' ? new Set([types]) : new Set(types);
  let cur = node.parent;
  while (cur) {
    if (set.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

const FN_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'function_signature',
  'generator_function_declaration',
  'generator_function',
]);

export function within(
  parent: Node,
  type: string,
  opts: { crossFunctions?: boolean } = {},
): Node[] {
  const out: Node[] = [];
  const cross = opts.crossFunctions === true;

  function walk(n: Node): void {
    for (const child of n.namedChildren) {
      if (child.type === type) {
        out.push(child);
      }
      const isFn = FN_TYPES.has(child.type);
      if (isFn && !cross) continue; // don't descend into nested functions
      walk(child);
    }
  }

  walk(parent);
  return out;
}
