import type { Node, Tree } from 'web-tree-sitter';

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

export interface ExportedDecl {
  node: Node;
  exportNode: Node;
  name: string | null;
  isDefault: boolean;
  isReExport: boolean;
  kind: 'class' | 'function' | 'const' | 'let' | 'type' | 'interface' | 'enum' | 'namespace' | 'reexport';
}

export interface ImportInfo {
  node: Node;
  source: string;
  kind: 'import' | 'require' | 'dynamic';
  names: string[];
  defaultName: string | null;
  namespaceName: string | null;
  isTypeOnly: boolean;
}

export interface MatchedCall {
  call: Node;
  callee: Node;
  object: Node | null;
  property: Node | null;
}

export interface Decorator {
  node: Node;
  name: string;
  args: Node[];
}

export type Modifier =
  | 'public' | 'private' | 'protected'
  | 'static' | 'readonly' | 'abstract'
  | 'async' | 'export';

export type CallTarget = string | { object?: string | RegExp; method?: string | RegExp; name?: string | RegExp };
