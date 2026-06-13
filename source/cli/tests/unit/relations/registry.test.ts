import { describe, it, expect } from 'vitest';
import { extractorForLanguage } from '../../../src/relations/extractors/registry.js';

describe('extractor registry', () => {
  it('returns undefined for an unknown language (data grammars too)', () => {
    expect(extractorForLanguage('json')).toBeUndefined();
    expect(extractorForLanguage('yaml')).toBeUndefined();
  });
  it('resolves the TypeScript extractor for ts/tsx/js (Phase 1)', () => {
    expect(extractorForLanguage('typescript')).toBeDefined();
    expect(extractorForLanguage('tsx')).toBeDefined();
    expect(extractorForLanguage('javascript')).toBeDefined();
  });
  it('resolves the Kotlin extractor (Phase 6, symbol-table resolved)', () => {
    expect(extractorForLanguage('kotlin')).toBeDefined();
  });
  it('resolves the Rust extractor (Phase 7, crate module-tree resolved)', () => {
    expect(extractorForLanguage('rust')).toBeDefined();
  });
});
