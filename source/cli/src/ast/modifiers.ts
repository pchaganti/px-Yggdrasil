import type { Node } from 'web-tree-sitter';
import type { Modifier } from './types.js';

const MODIFIER_TOKEN_TYPES = new Set<string>([
  'static', 'readonly', 'abstract', 'async', 'export',
  'private', 'public', 'protected',
]);

/**
 * Returns the set of modifiers present on the given node.
 *
 * Covers:
 *   - Unnamed keyword tokens: static, readonly, abstract, async, export
 *   - accessibility_modifier named children: private, public, protected
 *   - Direct unnamed children with types: private, public, protected
 *     (fallback for grammars that use them as plain tokens)
 */
export function modifiersOf(node: Node): Set<Modifier> {
  const result = new Set<Modifier>();

  for (const child of node.children) {
    // accessibility_modifier is a named node wrapping private/public/protected
    if (child.type === 'accessibility_modifier') {
      const text = child.text as Modifier;
      if (isModifier(text)) result.add(text);
      continue;
    }

    // Direct keyword tokens (unnamed or named)
    if (MODIFIER_TOKEN_TYPES.has(child.type)) {
      result.add(child.type as Modifier);
    }
  }

  return result;
}

function isModifier(text: string): text is Modifier {
  return (
    text === 'public' ||
    text === 'private' ||
    text === 'protected' ||
    text === 'static' ||
    text === 'readonly' ||
    text === 'abstract' ||
    text === 'async' ||
    text === 'export'
  );
}
