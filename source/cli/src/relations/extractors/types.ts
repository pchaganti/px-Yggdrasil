import type { Tree } from 'web-tree-sitter';

export type DepKind = 'import' | 'call' | 'extends' | 'implements' | 'type-ref' | 'construct';
export type TargetHint =
  | { kind: 'path'; specifier: string; isPackage?: boolean }
  | { kind: 'symbol'; symbolKey: string };

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
