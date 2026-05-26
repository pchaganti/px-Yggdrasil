import { describe, it, expect } from 'vitest';
import { LANGUAGES, EXTENSION_TO_LANGUAGE, getLanguageForExtension, getExtensionsForLanguage } from '../../../src/core/graph/language-registry.js';

describe('language registry phase 1 stub', () => {
  it('lists ts/tsx/javascript only', () => {
    expect(Object.keys(LANGUAGES).sort()).toEqual(['javascript', 'tsx', 'typescript']);
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
