import { describe, it, expect, beforeAll } from 'vitest';
import { parseFile, getParser } from '../../../src/ast/parser.js';

describe('ast/parser', () => {
  beforeAll(async () => {
    await getParser('.ts');
  });

  it('parses .ts files with tree-sitter-typescript', async () => {
    const tree = await parseFile('foo.ts', 'const x = 1;');
    expect(tree).toBeDefined();
    expect(tree.rootNode.type).toBe('program');
  });

  it('parses .tsx files', async () => {
    const tree = await parseFile('foo.tsx', 'const X = () => <div />;');
    expect(tree).toBeDefined();
    expect(tree.rootNode.type).toBe('program');
  });

  it('parses .js files', async () => {
    const tree = await parseFile('foo.js', 'const x = 1;');
    expect(tree).toBeDefined();
    expect(tree.rootNode.type).toBe('program');
  });

  it('throws on unsupported extension', async () => {
    await expect(parseFile('foo.py', 'x = 1')).rejects.toThrow(/no parser for extension/);
  });
});
