import { describe, it, expect } from 'vitest';
import { LANGUAGES, EXTENSION_TO_LANGUAGE, getLanguageForExtension, getExtensionsForLanguage, getGrammarForExtension } from '../../../src/core/graph/language-registry.js';

describe('language registry', () => {
  it('lists Tier 0 (ts/tsx/js) + Tier 1 + JSON', () => {
    expect(Object.keys(LANGUAGES).sort()).toEqual([
      'c', 'cpp', 'csharp', 'go', 'java', 'javascript', 'json',
      'php', 'python', 'ruby', 'rust', 'tsx', 'typescript',
    ]);
  });

  it('each entry id matches its key and has a wasmFile + wasmPackage', () => {
    for (const [key, def] of Object.entries(LANGUAGES)) {
      expect(def.id).toBe(key);
      expect(def.wasmFile).toMatch(/\.wasm$/);
      expect(def.wasmPackage.length).toBeGreaterThan(0);
    }
  });

  it('extension map is consistent with each LANGUAGES entry', () => {
    for (const [ext, lang] of Object.entries(EXTENSION_TO_LANGUAGE)) {
      expect(LANGUAGES[lang].extensions).toContain(ext);
    }
  });

  it('no extension appears in two language entries', () => {
    const seen = new Set<string>();
    for (const def of Object.values(LANGUAGES)) {
      for (const ext of def.extensions) {
        expect(seen.has(ext)).toBe(false);
        seen.add(ext);
      }
    }
  });

  it('.ts → typescript', () => {
    expect(getLanguageForExtension('.ts')).toBe('typescript');
  });

  it('.tsx → tsx', () => {
    expect(getLanguageForExtension('.tsx')).toBe('tsx');
  });

  it('unknown returns null', () => {
    expect(getLanguageForExtension('.zig')).toBeNull();
  });

  it('user overrides win', () => {
    expect(getLanguageForExtension('.h', { '.h': 'cpp' })).toBe('cpp');
  });

  it('each language has commentTypes', () => {
    expect(LANGUAGES.typescript.commentTypes).toContain('comment');
    expect(LANGUAGES.tsx.commentTypes).toContain('comment');
    expect(LANGUAGES.javascript.commentTypes).toContain('comment');
  });

  it('.jsx maps to javascript (not tsx)', () => {
    expect(getLanguageForExtension('.jsx')).toBe('javascript');
  });

  it('getExtensionsForLanguage returns extensions for known language', () => {
    expect(getExtensionsForLanguage('typescript')).toEqual(['.ts']);
    expect(getExtensionsForLanguage('javascript')).toEqual(['.js', '.mjs', '.cjs', '.jsx']);
  });

  it('getExtensionsForLanguage returns empty array for unknown language', () => {
    expect(getExtensionsForLanguage('cobol')).toEqual([]);
  });
});

describe('getGrammarForExtension', () => {
  it('maps .ts to the typescript grammar + package', () => {
    expect(getGrammarForExtension('.ts')).toEqual({ wasmFile: 'tree-sitter-typescript.wasm', wasmPackage: 'tree-sitter-typescript' });
  });
  it('maps .tsx to the tsx wasm but the typescript package', () => {
    expect(getGrammarForExtension('.tsx')).toEqual({ wasmFile: 'tree-sitter-tsx.wasm', wasmPackage: 'tree-sitter-typescript' });
  });
  it('maps .js/.mjs/.cjs/.jsx to the javascript grammar', () => {
    for (const ext of ['.js', '.mjs', '.cjs', '.jsx']) {
      expect(getGrammarForExtension(ext)).toEqual({ wasmFile: 'tree-sitter-javascript.wasm', wasmPackage: 'tree-sitter-javascript' });
    }
  });
  it('is case-insensitive (.TS resolves like .ts)', () => {
    expect(getGrammarForExtension('.TS')?.wasmFile).toBe('tree-sitter-typescript.wasm');
  });
  it('maps .py to the python grammar', () => {
    expect(getGrammarForExtension('.py')).toEqual({ wasmFile: 'tree-sitter-python.wasm', wasmPackage: 'tree-sitter-python' });
  });
  it('maps .rs to the rust grammar', () => {
    expect(getGrammarForExtension('.rs')).toEqual({ wasmFile: 'tree-sitter-rust.wasm', wasmPackage: 'tree-sitter-rust' });
  });
  it('returns null for a still-unregistered extension', () => {
    expect(getGrammarForExtension('.kt')).toBeNull();
  });
});
