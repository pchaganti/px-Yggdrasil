import type { Tree } from 'web-tree-sitter';

export interface SourceFile {
  /** Project-relative POSIX path */
  path: string;
  /** Raw source code */
  content: string;
  /** Parsed tree-sitter Tree */
  ast: Tree;
}

export interface CheckContext {
  files: SourceFile[];
}

export interface Violation {
  /** Project-relative POSIX path */
  file: string;
  /** 1-based line number */
  line: number;
  /** 0-based column number */
  column: number;
  message: string;
}

