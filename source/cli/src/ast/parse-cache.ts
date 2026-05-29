import type { Tree } from 'web-tree-sitter';
/** Per-invocation parse cache shared by AST and structure runners. */
export type ParseCache = Map<string, { content: string; ast: Tree }>;
