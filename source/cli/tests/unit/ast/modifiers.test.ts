import { describe, it, expect } from 'vitest';
import { modifiersOf } from '../../../src/ast/modifiers.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('ast.modifiersOf', () => {
  it('private method', async () => {
    const tree = await parseFile('x.ts', 'class C { private method() {} }');
    const m = tree.rootNode.descendantsOfType('method_definition')[0];
    expect(modifiersOf(m).has('private')).toBe(true);
  });

  it('public method', async () => {
    const tree = await parseFile('x.ts', 'class C { public method() {} }');
    const m = tree.rootNode.descendantsOfType('method_definition')[0];
    expect(modifiersOf(m).has('public')).toBe(true);
  });

  it('protected method', async () => {
    const tree = await parseFile('x.ts', 'class C { protected method() {} }');
    const m = tree.rootNode.descendantsOfType('method_definition')[0];
    expect(modifiersOf(m).has('protected')).toBe(true);
  });

  it('static method', async () => {
    const tree = await parseFile('x.ts', 'class C { static method() {} }');
    const m = tree.rootNode.descendantsOfType('method_definition')[0];
    expect(modifiersOf(m).has('static')).toBe(true);
  });

  it('readonly field', async () => {
    const tree = await parseFile('x.ts', 'class C { readonly x = 1; }');
    const f = tree.rootNode.descendantsOfType('public_field_definition')[0];
    expect(modifiersOf(f).has('readonly')).toBe(true);
  });

  it('abstract class', async () => {
    const tree = await parseFile('x.ts', 'abstract class C {}');
    const cls = tree.rootNode.descendantsOfType('abstract_class_declaration')[0]
      ?? tree.rootNode.descendantsOfType('class_declaration')[0];
    expect(modifiersOf(cls).has('abstract')).toBe(true);
  });

  it('async function', async () => {
    const tree = await parseFile('x.ts', 'async function foo() {}');
    const fn = tree.rootNode.descendantsOfType('function_declaration')[0];
    expect(modifiersOf(fn).has('async')).toBe(true);
  });

  it('export class → has export modifier', async () => {
    const tree = await parseFile('x.ts', 'export class Foo {}');
    const cls = tree.rootNode.descendantsOfType('class_declaration')[0];
    // Note: export may be on export_statement wrapper, not class itself
    // Try checking export_statement or class itself
    const exportStmt = tree.rootNode.descendantsOfType('export_statement')[0];
    const mods = modifiersOf(exportStmt ?? cls);
    expect(mods.has('export')).toBe(true);
  });

  it('combination: private static readonly returns all three', async () => {
    const tree = await parseFile('x.ts', 'class C { private static readonly X = 1; }');
    const f = tree.rootNode.descendantsOfType('public_field_definition')[0];
    const mods = modifiersOf(f);
    expect(mods.has('private')).toBe(true);
    expect(mods.has('static')).toBe(true);
    expect(mods.has('readonly')).toBe(true);
  });

  it('no modifiers → empty set', async () => {
    const tree = await parseFile('x.ts', 'class C { method() {} }');
    const m = tree.rootNode.descendantsOfType('method_definition')[0];
    expect(modifiersOf(m).size).toBe(0);
  });
});
