export interface LanguageDef {
  id: string;
  extensions: string[];
  wasmFile: string;
  wasmPackage: string;
  grammarRepo: string;
  grammarCommit: string;
  treeSitterCliVersion: string;
  externalScanner: boolean;
  commentTypes: string[];
  commentDelimiters: string[];
}

// Stub: TypeScript/TSX/JavaScript only; expands to more languages later.
// Pin/scanner fields empty for now — the build pipeline populates them later.
export const LANGUAGES: Record<string, LanguageDef> = {
  typescript: {
    id: 'typescript',
    extensions: ['.ts'],
    wasmFile: 'tree-sitter-typescript.wasm',
    wasmPackage: 'tree-sitter-typescript',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-typescript',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  tsx: {
    id: 'tsx',
    extensions: ['.tsx'],
    wasmFile: 'tree-sitter-tsx.wasm',
    wasmPackage: 'tree-sitter-typescript',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-typescript',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
  javascript: {
    id: 'javascript',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    wasmFile: 'tree-sitter-javascript.wasm',
    wasmPackage: 'tree-sitter-javascript',
    grammarRepo: 'https://github.com/tree-sitter/tree-sitter-javascript',
    grammarCommit: '',
    treeSitterCliVersion: '',
    externalScanner: false,
    commentTypes: ['comment'],
    commentDelimiters: ['//', '/*'],
  },
};

export const EXTENSION_TO_LANGUAGE: Record<string, string> = Object.fromEntries(
  Object.values(LANGUAGES).flatMap(def => def.extensions.map(ext => [ext, def.id])),
);

export function getLanguageForExtension(ext: string, overrides?: Record<string, string>): string | null {
  if (overrides && ext in overrides) return overrides[ext];
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

export function getExtensionsForLanguage(lang: string): string[] {
  return LANGUAGES[lang]?.extensions ?? [];
}

export function getGrammarForExtension(ext: string): { wasmFile: string; wasmPackage: string } | null {
  const lang = getLanguageForExtension(ext.toLowerCase());
  if (lang === null) return null;
  const def = LANGUAGES[lang];
  if (!def) return null;
  return { wasmFile: def.wasmFile, wasmPackage: def.wasmPackage };
}
