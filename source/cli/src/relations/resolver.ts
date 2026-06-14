import type { SymbolTable } from './symbol-table.js';
import type { OwnerIndex } from './owner-index.js';
import type { TargetHint } from './extractors/types.js';

export interface ResolvedTarget { ownerNode: string; resolvedFile: string }
export interface ResolverDeps {
  ownerIndex: OwnerIndex;
  symbolTable: SymbolTable;
  /** language-specific path → repo-rel file (or undefined). Injected per language. */
  resolvePathToFile: (specifier: string, fromFile: string, language: string, isPackage?: boolean) => string | undefined;
}
export interface TargetResolver { resolve(hint: TargetHint, fromFile: string, language: string): ResolvedTarget | undefined; }

export function makeResolver(deps: ResolverDeps): TargetResolver {
  return {
    resolve(hint, fromFile, language) {
      const file = hint.kind === 'symbol'
        ? deps.symbolTable.resolveUnique(language, hint.symbolKey)
        : deps.resolvePathToFile(hint.specifier, fromFile, language, hint.isPackage);
      if (!file) return undefined;                 // unresolved / ambiguous → silence
      const ownerNode = deps.ownerIndex.ownerOf(file);
      if (!ownerNode) return undefined;            // UNMAPPED target → coverage matter, never a violation (D7)
      return { ownerNode, resolvedFile: file };
    },
  };
}
