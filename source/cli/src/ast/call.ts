import type { Node } from 'web-tree-sitter';
import type { CallTarget, MatchedCall } from './types.js';

export function call(node: Node, target: CallTarget): MatchedCall | null {
  if (node.type !== 'call_expression') return null;
  const callee = node.childForFieldName('function');
  /* v8 ignore next 1 */
  if (!callee) return null;

  let object: Node | null = null;
  let property: Node | null = null;
  let bareName: string | null = null;

  if (callee.type === 'identifier') {
    bareName = callee.text;
  } else if (callee.type === 'member_expression') {
    object = callee.childForFieldName('object');
    property = callee.childForFieldName('property');
  } else {
    return null;
  }

  if (typeof target === 'string') {
    if (bareName !== target) return null;
    return { call: node, callee, object, property };
  }

  if (target.object !== undefined) {
    if (!object) return null;
    if (!matchText(object.text, target.object)) return null;
  }
  if (target.method !== undefined) {
    if (!property) return null;
    if (!matchText(property.text, target.method)) return null;
  }
  if (target.name !== undefined) {
    if (!bareName) return null;
    if (!matchText(bareName, target.name)) return null;
  }

  return { call: node, callee, object, property };
}

function matchText(text: string, spec: string | RegExp): boolean {
  return spec instanceof RegExp ? spec.test(text) : text === spec;
}
