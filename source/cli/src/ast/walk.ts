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
  const typeSet = typeof types === 'string' ? new Set([types]) : new Set(types);
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (typeSet.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}
