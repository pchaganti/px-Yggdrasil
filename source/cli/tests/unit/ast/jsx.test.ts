import { describe, it, expect } from 'vitest';
import { jsxElements } from '../../../src/ast/jsx.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('ast.jsxElements', () => {
  it('finds self-closing element', async () => {
    const tree = await parseFile('x.tsx', 'const X = () => <Foo />;');
    const elems = jsxElements(tree.rootNode);
    expect(elems.length).toBe(1);
    expect(elems.some(e => e.type === 'jsx_self_closing_element')).toBe(true);
  });

  it('finds opening element (not closing)', async () => {
    const tree = await parseFile('x.tsx', 'const X = () => <Foo><Bar /></Foo>;');
    const elems = jsxElements(tree.rootNode);
    // Should find Foo (opening) and Bar (self-closing), not Foo (closing)
    expect(elems.some(e => e.type === 'jsx_opening_element')).toBe(true);
    expect(elems.some(e => e.type === 'jsx_self_closing_element')).toBe(true);
  });

  it('empty when no JSX', async () => {
    const tree = await parseFile('x.tsx', 'const x = 1;');
    expect(jsxElements(tree.rootNode)).toEqual([]);
  });
});
