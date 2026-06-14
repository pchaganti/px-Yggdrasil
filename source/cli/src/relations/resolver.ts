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

/**
 * The candidate symbol keys for ONE dotted symbol reference: the verbatim dot-only key,
 * PLUS the guarded nested-type `+`-boundary splits. For a dotted candidate `s1...sn`, for
 * each split index `k` in `[1, n-1]` the key `s1..sk + '+' + s_{k+1}..sn` is added ONLY
 * when `s1..sk` is itself a declared TYPE in the table (`SymbolTable.has`, ≥1 def). This is
 * the language's true semantics — under a type you can only nest a type, never a namespace —
 * so splitting at a declared-type boundary recovers the real nested-type meaning (`Outer.Inner`
 * → the `Outer+Inner` declaration key), and never splitting at a namespace boundary keeps it
 * sound. A key with no `.` (already a bare or `+` key) has no split. Separator isolation: the
 * `+` keys live in a string space disjoint from the dot-only namespace candidates.
 */
function nestedSplitKeys(symbolTable: SymbolTable, language: string, symbolKey: string): string[] {
  const keys = [symbolKey];
  const segs = symbolKey.split('.');
  for (let k = 1; k < segs.length; k++) {
    const prefix = segs.slice(0, k).join('.');
    if (!symbolTable.has(language, prefix)) continue; // guard: split only at a declared TYPE
    keys.push(`${prefix}+${segs.slice(k).join('+')}`);
  }
  return keys;
}

export function makeResolver(deps: ResolverDeps): TargetResolver {
  /** The DISTINCT defining files a dotted symbol candidate maps to, across the verbatim key
   *  AND the guarded nested-type `+`-splits. The set-level rule: 0 distinct files → absent,
   *  exactly 1 → that file, ≥2 → ambiguous (silence). Counting every defining file (not the
   *  unique-or-undefined per-key result) keeps a genuine ambiguity — a single key with two
   *  defs, OR two plausible splits resolving to different files — as ≥2 distinct files, so the
   *  group silences rather than leaking to a farther candidate. */
  const symbolFiles = (language: string, symbolKey: string): Set<string> => {
    const files = new Set<string>();
    for (const key of nestedSplitKeys(deps.symbolTable, language, symbolKey)) {
      for (const f of deps.symbolTable.filesFor(language, key)) files.add(f);
    }
    return files;
  };

  const resolve: TargetResolver['resolve'] = (hint, fromFile, language) => {
    let file: string | undefined;
    if (hint.kind === 'symbol') {
      const files = symbolFiles(language, hint.symbolKey);
      if (files.size !== 1) return undefined;    // 0 → unresolved; ≥2 → ambiguous → silence
      file = [...files][0];
    } else {
      file = deps.resolvePathToFile(hint.specifier, fromFile, language, hint.isPackage);
    }
    if (!file) return undefined;                 // unresolved / ambiguous → silence
    const ownerNode = deps.ownerIndex.ownerOf(file);
    if (!ownerNode) return undefined;            // UNMAPPED target → coverage matter, never a violation (D7)
    return { ownerNode, resolvedFile: file };
  };

  const classify: TargetResolver['classify'] = (hint, fromFile, language) => {
    if (hint.kind === 'symbol') {
      // Symbol axis: collect the distinct files across the verbatim key + guarded `+`-splits.
      // ≥2 distinct files is a real ambiguity (silence the group); 0 is absent (continue);
      // exactly one is the candidate binding.
      const files = symbolFiles(language, hint.symbolKey);
      if (files.size === 0) return { kind: 'absent' };
      if (files.size >= 2) return { kind: 'ambiguous' };
      const file = [...files][0];
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
