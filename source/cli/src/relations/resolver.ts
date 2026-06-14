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

/**
 * The tri-state outcome of probing ONE candidate hint:
 *  - `resolved`  — the hint names exactly one definition (a unique mapped owner). That is
 *                  the binding: emit one edge, stop the group.
 *  - `ambiguous` — the hint names a key that WOULD bind here but has ≥2 definitions (a real
 *                  unresolvable ambiguity, symbol axis only). Stop the group with silence;
 *                  do NOT fall through to a farther candidate.
 *  - `absent`    — the hint resolves to no in-graph definition, or to an UNMAPPED file (the
 *                  D7 non-event). Continue to the next, farther candidate.
 */
export type Classification =
  | { kind: 'resolved'; ownerNode: string; resolvedFile: string }
  | { kind: 'ambiguous' }
  | { kind: 'absent' };

export interface TargetResolver {
  resolve(hint: TargetHint, fromFile: string, language: string): ResolvedTarget | undefined;
  classify(hint: TargetHint, fromFile: string, language: string): Classification;
}

export function makeResolver(deps: ResolverDeps): TargetResolver {
  const resolve: TargetResolver['resolve'] = (hint, fromFile, language) => {
    const file = hint.kind === 'symbol'
      ? deps.symbolTable.resolveUnique(language, hint.symbolKey)
      : deps.resolvePathToFile(hint.specifier, fromFile, language, hint.isPackage);
    if (!file) return undefined;                 // unresolved / ambiguous → silence
    const ownerNode = deps.ownerIndex.ownerOf(file);
    if (!ownerNode) return undefined;            // UNMAPPED target → coverage matter, never a violation (D7)
    return { ownerNode, resolvedFile: file };
  };

  const classify: TargetResolver['classify'] = (hint, fromFile, language) => {
    if (hint.kind === 'symbol') {
      // Symbol axis: a key with ≥2 definitions is a real ambiguity (silence the group);
      // 0 definitions is absent (continue); exactly one is the candidate binding.
      const count = deps.symbolTable.defCount(language, hint.symbolKey);
      if (count === 0) return { kind: 'absent' };
      if (count >= 2) return { kind: 'ambiguous' };
      const file = deps.symbolTable.resolveUnique(language, hint.symbolKey)!;
      const ownerNode = deps.ownerIndex.ownerOf(file);
      // Resolved-but-UNMAPPED is the D7 non-event → absent (continue), never ambiguous.
      return ownerNode ? { kind: 'resolved', ownerNode, resolvedFile: file } : { kind: 'absent' };
    }
    // Path axis (PHP/Java/TS/JS/Py/Go/Rust/C/C++): resolution maps to AT MOST ONE file,
    // so there is no `ambiguous` outcome on the path axis — only resolved or absent.
    const file = deps.resolvePathToFile(hint.specifier, fromFile, language, hint.isPackage);
    if (!file) return { kind: 'absent' };
    const ownerNode = deps.ownerIndex.ownerOf(file);
    return ownerNode ? { kind: 'resolved', ownerNode, resolvedFile: file } : { kind: 'absent' };
  };

  return { resolve, classify };
}
