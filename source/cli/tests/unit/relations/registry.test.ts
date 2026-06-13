import { describe, it, expect } from 'vitest';
import { extractorForLanguage } from '../../../src/relations/extractors/registry.js';

describe('extractor registry', () => {
  it('returns undefined for an unknown language (data grammars too)', () => {
    expect(extractorForLanguage('json')).toBeUndefined();
    expect(extractorForLanguage('yaml')).toBeUndefined();
  });
  it('returns undefined until any extractor is registered (Phase 0 stub)', () => {
    expect(extractorForLanguage('typescript')).toBeUndefined();
  });
});
