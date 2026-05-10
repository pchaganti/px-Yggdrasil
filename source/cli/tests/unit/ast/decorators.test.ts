import { describe, it, expect } from 'vitest';
import { decoratorsOf } from '../../../src/ast/decorators.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('ast.decoratorsOf', () => {
  it('bare decorator → name=Foo, args=[]', async () => {
    const tree = await parseFile('x.ts', '@Foo\nclass X {}');
    const cls = tree.rootNode.descendantsOfType('class_declaration')[0];
    const [d] = decoratorsOf(cls);
    expect(d.name).toBe('Foo');
    expect(d.args).toEqual([]);
  });

  it('call decorator no args → name=Foo, args=[]', async () => {
    const tree = await parseFile('x.ts', '@Foo()\nclass X {}');
    const cls = tree.rootNode.descendantsOfType('class_declaration')[0];
    const [d] = decoratorsOf(cls);
    expect(d.name).toBe('Foo');
    expect(d.args.length).toBe(0);
  });

  it('call decorator with args → args populated in order', async () => {
    const tree = await parseFile('x.ts', '@Foo("a", b)\nclass X {}');
    const cls = tree.rootNode.descendantsOfType('class_declaration')[0];
    const [d] = decoratorsOf(cls);
    expect(d.args.length).toBe(2);
    expect(d.args[0].text).toBe('"a"');
    expect(d.args[1].text).toBe('b');
  });

  it('member-expression decorator @ns.Foo → name = last identifier', async () => {
    const tree = await parseFile('x.ts', '@ns.Foo\nclass X {}');
    const cls = tree.rootNode.descendantsOfType('class_declaration')[0];
    const [d] = decoratorsOf(cls);
    expect(d.name).toBe('Foo');
  });

  it('multiple decorators in source order', async () => {
    const tree = await parseFile('x.ts', '@Injectable()\n@Controller()\nclass X {}');
    const cls = tree.rootNode.descendantsOfType('class_declaration')[0];
    const list = decoratorsOf(cls);
    expect(list.map(d => d.name)).toEqual(['Injectable', 'Controller']);
  });

  it('decorated class via export statement', async () => {
    const tree = await parseFile('x.ts', '@Foo\nexport class X {}');
    const cls = tree.rootNode.descendantsOfType('class_declaration')[0];
    expect(decoratorsOf(cls).map(d => d.name)).toEqual(['Foo']);
  });
});
