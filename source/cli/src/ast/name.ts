import type { Node } from 'web-tree-sitter';

const NAMED_TYPES = new Set([
  'class_declaration',
  'function_declaration',
  'function_signature',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'method_definition',
  'variable_declarator',
  'internal_module',
  'module',
]);

export function nameOf(node: Node): string | null {
  if (NAMED_TYPES.has(node.type)) {
    return node.childForFieldName('name')?.text ?? null;
  }
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    if (node.parent?.type === 'variable_declarator') {
      return node.parent.childForFieldName('name')?.text ?? null;
    }
    return null;
  }
  if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
    const tagName = node.childForFieldName('name') ?? node.namedChildren[0];
    return tagName?.text ?? null;
  }
  if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'property_identifier') {
    return node.text;
  }
  return null;
}
