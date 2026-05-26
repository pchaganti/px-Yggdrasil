import type { Node } from 'web-tree-sitter';
import type { SourceFile, Violation } from './types.js';

export function report(file: SourceFile, node: Node, message: string): Violation {
  return {
    file: file.path,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    message,
  };
}
