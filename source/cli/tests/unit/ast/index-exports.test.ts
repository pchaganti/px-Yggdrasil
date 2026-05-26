import { describe, it, expect } from 'vitest';
import * as astModule from '../../../src/ast/index.js';

describe('ast index — named exports', () => {
  it('new named exports present', () => {
    expect(typeof astModule.walk).toBe('function');
    expect(typeof astModule.report).toBe('function');
    expect(typeof astModule.inFile).toBe('function');
    expect(typeof astModule.findComments).toBe('function');
    expect(typeof astModule.closest).toBe('function');
  });

  it('legacy ast namespace is gone', () => {
    expect((astModule as any).ast).toBeUndefined();
  });
});
