import { describe, it, expect } from 'vitest';
import * as astModule from '../../../src/ast/index.js';

describe('ast index — new + legacy exports', () => {
  it('new named exports present', () => {
    expect(typeof astModule.walk).toBe('function');
    expect(typeof astModule.report).toBe('function');
    expect(typeof astModule.inFile).toBe('function');
    expect(typeof astModule.findComments).toBe('function');
    expect(typeof astModule.closest).toBe('function');
  });

  it('legacy ast namespace works', () => {
    expect(typeof astModule.ast.call).toBe('function');
    expect(typeof astModule.ast.within).toBe('function');
    expect(typeof astModule.ast.imports).toBe('function');
  });

  it('legacy ast.inFile shim — glob', () => {
    const f = { path: 'src/foo.ts', content: '', ast: null as any };
    expect(astModule.ast.inFile(f, 'src/**/*.ts')).toBe(true);
  });

  it('legacy ast.inFile shim — regex string /pattern/', () => {
    const f = { path: 'src/foo.ts', content: '', ast: null as any };
    expect(astModule.ast.inFile(f, '/\\.ts$/')).toBe(true);
  });

  it('legacy ast.inFile shim — falls back to contains', () => {
    const f = { path: 'src/api/handler.ts', content: '', ast: null as any };
    expect(astModule.ast.inFile(f, 'api/')).toBe(true);
  });
});
