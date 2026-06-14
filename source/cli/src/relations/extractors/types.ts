import type { Tree } from 'web-tree-sitter';

export type DepKind = 'import' | 'call' | 'extends' | 'implements' | 'type-ref' | 'construct';
export type TargetHint =
  | { kind: 'path'; specifier: string; isPackage?: boolean }
  | { kind: 'symbol'; symbolKey: string };
export interface DetectedDep { targetHint: TargetHint; kind: DepKind; line: number }
export interface DeclaredSymbol { symbolKey: string; line: number }
export interface ParsedFile { path: string; content: string; tree: Tree; language: string }
export interface DependencyExtractor {
  readonly languages: ReadonlySet<string>;
  declarations(file: ParsedFile): DeclaredSymbol[];
  uses(file: ParsedFile): DetectedDep[];
}
