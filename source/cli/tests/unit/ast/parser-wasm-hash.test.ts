import { describe, it, expect } from 'vitest';
import { grammarWasmHash } from '../../../src/ast/parser.js';

describe('grammarWasmHash', () => {
  it('is a stable 64-hex sha256 for a known grammar', () => {
    const h = grammarWasmHash('.ts');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(grammarWasmHash('.ts')).toBe(h); // memoized + stable
  });
  it('differs across grammars', () => {
    expect(grammarWasmHash('.ts')).not.toBe(grammarWasmHash('.py'));
  });
});
