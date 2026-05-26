import type { Tree, Node } from 'web-tree-sitter';
import { LANGUAGES } from '../core/graph/language-registry.js';

export type FindCommentsTarget =
  | { ast: Tree; language: string }
  | { rootNode: Node; language: string };

export function findComments(target: FindCommentsTarget): Node[] {
  const hasAst = 'ast' in target;
  const hasRootNode = 'rootNode' in target;
  if (hasAst && hasRootNode) {
    throw new Error('AST_FINDCOMMENTS_AMBIGUOUS_TARGET: pass either ast or rootNode, not both');
  }
  const def = LANGUAGES[target.language];
  if (def === undefined) {
    throw new Error(`AST_FINDCOMMENTS_UNKNOWN_LANGUAGE: '${target.language}' not in registry`);
  }
  const root: Node = hasAst
    ? (target as { ast: Tree }).ast.rootNode
    : (target as { rootNode: Node }).rootNode;
  const out: Node[] = [];
  for (const type of def.commentTypes) {
    out.push(...root.descendantsOfType(type));
  }
  return out;
}
