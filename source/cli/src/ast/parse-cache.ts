import type { Tree } from 'web-tree-sitter';
/** Per-invocation parse cache shared by AST and structure runners. */
export type ParseCache = Map<string, { content: string; ast: Tree }>;

/**
 * Delete every WASM Tree in the cache and clear it. Call this when a locally-owned
 * ParseCache goes out of scope — web-tree-sitter objects are backed by the WASM heap
 * and are not freed by JavaScript GC; without explicit deletion large repos exhaust
 * the heap and trigger an Aborted() crash. Callers that received a ParseCache from
 * outside (params.parseCache) must NOT call this — the owner cleans up.
 */
export function destroyParseCache(cache: ParseCache): void {
  for (const { ast } of cache.values()) {
    ast.delete();
  }
  cache.clear();
}
