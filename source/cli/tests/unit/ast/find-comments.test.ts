import { describe, it, expect } from 'vitest';
import { findComments } from '../../../src/ast/find-comments.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('findComments', () => {
  it('file form returns all comments', async () => {
    const src = '// hi\nconst x = 1; /* bye */';
    const tree = await parseFile('test.ts', src);
    const comments = findComments({ ast: tree, language: 'typescript' });
    expect(comments.length).toBe(2);
    expect(comments[0].text).toBe('// hi');
    expect(comments[1].text).toBe('/* bye */');
  });

  it('subtree form scopes search', async () => {
    const tree = await parseFile('test.ts', '// outside\nfunction f() { /* inside */ return 1; }');
    const fn = tree.rootNode.namedChildren.find(c => c.type === 'function_declaration')!;
    const comments = findComments({ rootNode: fn, language: 'typescript' });
    expect(comments.length).toBe(1);
    expect(comments[0].text).toBe('/* inside */');
  });

  it('both ast and rootNode throws AST_FINDCOMMENTS_AMBIGUOUS_TARGET', async () => {
    const tree = await parseFile('test.ts', '// x');
    expect(() => findComments({ ast: tree, rootNode: tree.rootNode, language: 'typescript' } as any))
      .toThrow(/AST_FINDCOMMENTS_AMBIGUOUS_TARGET/);
  });

  it('unknown language throws', async () => {
    const tree = await parseFile('test.ts', '// x');
    expect(() => findComments({ ast: tree, language: 'martian' }))
      .toThrow();
  });
});
