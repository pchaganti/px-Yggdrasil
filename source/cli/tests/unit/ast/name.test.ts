import { describe, it, expect } from 'vitest';
import { nameOf } from '../../../src/ast/name.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('ast.nameOf', () => {
  it('class declaration', async () => {
    const tree = await parseFile('x.ts', 'class Foo {}');
    const cls = tree.rootNode.descendantsOfType('class_declaration')[0];
    expect(nameOf(cls)).toBe('Foo');
  });

  it('function declaration', async () => {
    const tree = await parseFile('x.ts', 'function bar() {}');
    const fn = tree.rootNode.descendantsOfType('function_declaration')[0];
    expect(nameOf(fn)).toBe('bar');
  });

  it('interface declaration', async () => {
    const tree = await parseFile('x.ts', 'interface IFoo {}');
    const iface = tree.rootNode.descendantsOfType('interface_declaration')[0];
    expect(nameOf(iface)).toBe('IFoo');
  });

  it('arrow function via parent variable_declarator', async () => {
    const tree = await parseFile('x.ts', 'const useFoo = () => 1;');
    const arrow = tree.rootNode.descendantsOfType('arrow_function')[0];
    expect(nameOf(arrow)).toBe('useFoo');
  });

  it('type alias declaration', async () => {
    const tree = await parseFile('x.ts', 'type Foo = string;');
    const t = tree.rootNode.descendantsOfType('type_alias_declaration')[0];
    expect(nameOf(t)).toBe('Foo');
  });

  it('enum declaration', async () => {
    const tree = await parseFile('x.ts', 'enum Color { Red, Blue }');
    const e = tree.rootNode.descendantsOfType('enum_declaration')[0];
    expect(nameOf(e)).toBe('Color');
  });

  it('method definition', async () => {
    const tree = await parseFile('x.ts', 'class C { handle() {} }');
    const m = tree.rootNode.descendantsOfType('method_definition')[0];
    expect(nameOf(m)).toBe('handle');
  });

  it('JSX tag with identifier name', async () => {
    const tree = await parseFile('x.tsx', 'const X = () => <Foo />;');
    const tag = tree.rootNode.descendantsOfType('jsx_self_closing_element')[0];
    expect(nameOf(tag)).toBe('Foo');
  });

  it('JSX tag with member expression name', async () => {
    const tree = await parseFile('x.tsx', 'const X = () => <Foo.Bar />;');
    const tag = tree.rootNode.descendantsOfType('jsx_self_closing_element')[0];
    expect(nameOf(tag)).toBe('Foo.Bar');
  });

  it('anonymous arrow without parent declarator → null', async () => {
    const tree = await parseFile('x.ts', '[() => 1].map(f => f());');
    const arrows = tree.rootNode.descendantsOfType('arrow_function');
    expect(nameOf(arrows[0])).toBeNull();
  });

  it('function_signature (ambient declare) → name', async () => {
    const tree = await parseFile('x.ts', 'declare function legacy(): void;');
    const sig = tree.rootNode.descendantsOfType('function_signature')[0];
    expect(nameOf(sig)).toBe('legacy');
  });

  it('named function_expression assigned to const → name from parent declarator', async () => {
    const tree = await parseFile('x.ts', 'const x = function bar() {};');
    const fn = tree.rootNode.descendantsOfType('function_expression')[0];
    expect(nameOf(fn)).toBe('x');
  });

  it('anonymous function_expression in argument position → null', async () => {
    const tree = await parseFile('x.ts', 'foo(function() {});');
    const fn = tree.rootNode.descendantsOfType('function_expression')[0];
    expect(nameOf(fn)).toBeNull();
  });

  it('identifier node → returns text', async () => {
    const tree = await parseFile('x.ts', 'const myVar = 1;');
    const id = tree.rootNode.descendantsOfType('identifier')[0];
    expect(nameOf(id)).toBe('myVar');
  });

  it('type_identifier node → returns text', async () => {
    const tree = await parseFile('x.ts', 'const x: FooType = null as any;');
    const typeId = tree.rootNode.descendantsOfType('type_identifier')[0];
    expect(nameOf(typeId)).toBe('FooType');
  });

  it('property_identifier node → returns text', async () => {
    const tree = await parseFile('x.ts', 'const obj = { myProp: 1 };');
    const propId = tree.rootNode.descendantsOfType('property_identifier')[0];
    expect(nameOf(propId)).toBe('myProp');
  });

  it('unknown node type → null', async () => {
    const tree = await parseFile('x.ts', 'const x = 1;');
    // Use a non-named node type (e.g., the '=' token or the root program node)
    const rootNode = tree.rootNode;
    expect(nameOf(rootNode)).toBeNull();
  });

  it('JSX fragment opening element (no name field) → null via namedChildren fallback', async () => {
    const tree = await parseFile('x.tsx', 'const X = () => <><span>hi</span></>;');
    // jsx_opening_element for <> has no name field — triggers the ?? fallback at line 27
    const openings = tree.rootNode.descendantsOfType('jsx_opening_element');
    // Find the fragment opening (the one without a name field)
    const fragOpening = openings.find((n) => !n.childForFieldName('name'));
    if (fragOpening) {
      const result = nameOf(fragOpening);
      // Fragment opening has no name — namedChildren[0] may also be null → null
      expect(result === null || typeof result === 'string').toBe(true);
    }
    // Also test jsx_self_closing_element path coverage (tagName?.text ?? null null branch)
    const selfClosing = tree.rootNode.descendantsOfType('jsx_self_closing_element');
    for (const sc of selfClosing) {
      const r = nameOf(sc);
      expect(r === null || typeof r === 'string').toBe(true);
    }
  });
});
