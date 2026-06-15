import type { Tree } from 'web-tree-sitter';

export type DepKind = 'import' | 'call' | 'extends' | 'implements' | 'type-ref' | 'construct';

/** One member of a symbol resolution SET (C# only). `symbolKey` is resolved exactly like a
 *  plain symbol hint; `nestedOnly` (R4) restricts it to the guarded nested-type `+`-split
 *  reading, never the verbatim dotted reading. */
export interface SymbolSetMember { symbolKey: string; nestedOnly?: boolean }

export type TargetHint =
  | { kind: 'path'; specifier: string; isPackage?: boolean }
  | {
      kind: 'symbol';
      /** The candidate's OWN display key — what `groupContaining`/`symbolKeys` read, and what
       *  pins the ordered-group shape. Always present. */
      symbolKey: string;
      /** R4 (C#): resolve `symbolKey` ONLY via the guarded nested-type `+`-split, never the
       *  verbatim dotted form. A `using A;` prefix applied to a multi-segment ref `B.Type` is
       *  only valid when `A.B` is a declared TYPE (→ `A.B+Type`); a sub-namespace reading
       *  (`A.B.Type` dotted) is forbidden. Absent = resolve verbatim + splits normally. */
      nestedOnly?: boolean;
      /** R9/R8 (C#): when present, classification resolves the UNION of files across ALL set
       *  members (each honoring its own `nestedOnly`) and applies the distinct-file rule:
       *  0 → absent, exactly 1 → resolved, ≥2 → ambiguous (CS0104 / co-definition silence).
       *  The candidate's own `symbolKey` still drives the display shape; `set` drives only
       *  classification. Absent = resolve `symbolKey` alone as a singleton. */
      set?: SymbolSetMember[];
    };

/**
 * A detected reference carries an ORDERED list of alternative target hints, in the
 * language's name-binding order (nearest binding first, verbatim/top-level last). The
 * per-reference resolver (`pass.ts`) walks the list and takes the FIRST candidate that
 * binds to a unique mapped definition — that IS the binding — emits at most one edge, and
 * stops; a present-but-ambiguous nearer candidate silences the whole group.
 *
 * A single-hint extractor wraps its one hint as a ONE-ELEMENT `candidates` array (use the
 * `single` helper). For a one-element group the ordered walk degenerates to a single
 * resolve with byte-identical outcomes — no path-resolved extractor changes behavior.
 */
export interface DetectedDep { candidates: TargetHint[]; kind: DepKind; line: number }

/** Wrap one hint as a one-element ordered candidate group. */
export function single(hint: TargetHint, kind: DepKind, line: number): DetectedDep {
  return { candidates: [hint], kind, line };
}
export interface DeclaredSymbol { symbolKey: string; line: number }
export interface ParsedFile { path: string; content: string; tree: Tree; language: string }
export interface DependencyExtractor {
  readonly languages: ReadonlySet<string>;
  declarations(file: ParsedFile): DeclaredSymbol[];
  uses(file: ParsedFile): DetectedDep[];
}
