import { describe, it, expect } from 'vitest';
import { report } from '../../../src/ast/report.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('ast.report', () => {
  it('builds Violation with 1-based line', async () => {
    const tree = await parseFile('foo.ts', '\nconst x = 1;');
    const node = tree.rootNode.descendantsOfType('lexical_declaration')[0];
    const file = { path: 'src/foo.ts', content: '\nconst x = 1;', ast: tree };
    const v = report(file, node, 'forbidden');
    expect(v).toEqual({ file: 'src/foo.ts', line: 2, message: 'forbidden' });
  });
});
