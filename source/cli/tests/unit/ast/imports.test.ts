import { describe, it, expect } from 'vitest';
import { imports as importsHelper } from '../../../src/ast/imports.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('ast.imports', () => {
  it('default import', async () => {
    const tree = await parseFile('x.ts', 'import X from "y";');
    const [i] = importsHelper(tree.rootNode);
    expect(i.kind).toBe('import');
    expect(i.source).toBe('y');
    expect(i.defaultName).toBe('X');
    expect(i.names).toEqual([]);
    expect(i.namespaceName).toBeNull();
    expect(i.isTypeOnly).toBe(false);
  });

  it('named imports', async () => {
    const tree = await parseFile('x.ts', 'import { a, b } from "y";');
    const [i] = importsHelper(tree.rootNode);
    expect(i.names).toEqual(['a', 'b']);
    expect(i.defaultName).toBeNull();
  });

  it('namespace import', async () => {
    const tree = await parseFile('x.ts', 'import * as ns from "y";');
    const [i] = importsHelper(tree.rootNode);
    expect(i.namespaceName).toBe('ns');
    expect(i.names).toEqual([]);
  });

  it('type-only import', async () => {
    const tree = await parseFile('x.ts', 'import type { A } from "y";');
    const [i] = importsHelper(tree.rootNode);
    expect(i.isTypeOnly).toBe(true);
  });

  it('mixed default + named', async () => {
    const tree = await parseFile('x.ts', 'import X, { y } from "z";');
    const [i] = importsHelper(tree.rootNode);
    expect(i.defaultName).toBe('X');
    expect(i.names).toEqual(['y']);
  });

  it('require call', async () => {
    const tree = await parseFile('x.js', 'const X = require("y");');
    const [i] = importsHelper(tree.rootNode);
    expect(i.kind).toBe('require');
    expect(i.source).toBe('y');
  });

  it('dynamic import', async () => {
    const tree = await parseFile('x.js', 'const m = await import("y");');
    const [i] = importsHelper(tree.rootNode);
    expect(i.kind).toBe('dynamic');
    expect(i.source).toBe('y');
  });

  it('side-effect-only import', async () => {
    const tree = await parseFile('x.ts', 'import "y";');
    const [i] = importsHelper(tree.rootNode);
    expect(i.kind).toBe('import');
    expect(i.source).toBe('y');
    expect(i.names).toEqual([]);
    expect(i.defaultName).toBeNull();
    expect(i.namespaceName).toBeNull();
    expect(i.isTypeOnly).toBe(false);
  });
});
