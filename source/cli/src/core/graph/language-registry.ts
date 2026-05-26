export interface LanguageDef {
  id: string;
  extensions: string[];
  wasmFile: string;
  grammarRepo: string;
  grammarCommit: string;
  treeSitterCliVersion: string;
  externalScanner: boolean;
  commentTypes: string[];
  commentDelimiters: string[];
}

// Phase 1 stub: TS/TSX/JS only. Phase 3 expands to 35.
// Pin/scanner fields empty in phase 1 — phase 4 build pipeline populates.
export const LANGUAGES: Record<string, LanguageDef> = {
  typescript: {
    id: 'typescript',
    extensions: ['.ts'],
    wasmFile: 'tree-sitter-typescript.wasm',
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
