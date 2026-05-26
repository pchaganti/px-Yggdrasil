import { describe, it, expect } from 'vitest';
import { closest, within, walk } from '../../../src/ast/walk.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('ast.closest', () => {
  it('returns nearest ancestor of given type', async () => {
    const tree = await parseFile('x.ts', 'class Foo { method() { const x = 1; } }');
    const decl = tree.rootNode.descendantsOfType('lexical_declaration')[0];
    expect(closest(decl, 'class_declaration')?.type).toBe('class_declaration');
    expect(closest(decl, ['method_definition', 'function_declaration'])?.type).toBe('method_definition');
    expect(closest(decl, 'enum_declaration')).toBeNull();
  });
});

describe('ast.within', () => {
  it('does NOT cross function boundaries by default', async () => {
    const tree = await parseFile('x.ts', `
      function outer() {
        const inner = () => { fs.readFileSync('x'); };
        fs.readFileSync('y');
      }
    `);
    const outer = tree.rootNode.descendantsOfType('function_declaration')[0];
    const calls = within(outer, 'call_expression');
    expect(calls.length).toBe(1);
  });

  it('with crossFunctions: true descends into nested functions', async () => {
    const tree = await parseFile('x.ts', `
      function outer() {
        const inner = () => { fs.readFileSync('x'); };
        fs.readFileSync('y');
      }
    `);
    const outer = tree.rootNode.descendantsOfType('function_declaration')[0];
    const calls = within(outer, 'call_expression', { crossFunctions: true });
    expect(calls.length).toBe(2);
  });

  it('stops at function_expression boundary by default', async () => {
    const tree = await parseFile('x.ts', `
      function outer() {
        const inner = function() { fs.readFileSync('x'); };
        fs.readFileSync('y');
      }
    `);
    const outer = tree.rootNode.descendantsOfType('function_declaration')[0];
    expect(within(outer, 'call_expression').length).toBe(1);
  });

  it('stops at method_definition boundary by default', async () => {
    const tree = await parseFile('x.ts', `
      class C {
        method() {
          const inner = () => fs.readFileSync('x');
          fs.readFileSync('y');
        }
      }
    `);
    const m = tree.rootNode.descendantsOfType('method_definition')[0];
    expect(within(m, 'call_expression').length).toBe(1);
  });

  it('stops at generator_function boundary by default', async () => {
    const tree = await parseFile('x.ts', `
      function* outer() {
        const inner = function*() { yield fs.readFileSync('x'); };
        yield fs.readFileSync('y');
      }
    `);
    // Try both node type names
    const outer = tree.rootNode.descendantsOfType('generator_function_declaration')[0]
      ?? tree.rootNode.descendantsOfType('function_declaration')[0];
    expect(within(outer, 'call_expression').length).toBe(1);
  });
});

describe('ast.walk', () => {
  it('visits root then children in document order', async () => {
    const tree = await parseFile('test.ts', 'const x = 1; const y = 2;');
    const types: string[] = [];
    walk(tree.rootNode, (node) => { types.push(node.type); });
    expect(types[0]).toBe('program');
    expect(types.filter(t => t === 'lexical_declaration').length).toBe(2);
  });

  it('returning false skips subtree but continues siblings', async () => {
    const tree = await parseFile('test.ts', 'function f() { const x = 1; } const y = 2;');
    const visited: string[] = [];
    walk(tree.rootNode, (node) => {
      visited.push(node.type);
      if (node.type === 'function_declaration') return false;
    });
    expect(visited).toContain('function_declaration');
    expect(visited.filter(t => t === 'variable_declarator').length).toBe(1);
  });

  it('returning undefined descends normally', async () => {
    const tree = await parseFile('test.ts', 'function f() { const x = 1; }');
    const visited: string[] = [];
    walk(tree.rootNode, (node) => { visited.push(node.type); });
    expect(visited).toContain('variable_declarator');
  });

  it('returning true descends (only false stops)', async () => {
    const tree = await parseFile('test.ts', 'function f() { const x = 1; }');
    const visited: string[] = [];
    walk(tree.rootNode, (node) => { visited.push(node.type); return true; });
    expect(visited).toContain('variable_declarator');
  });
});
