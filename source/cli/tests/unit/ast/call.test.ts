import { describe, it, expect } from 'vitest';
import { call } from '../../../src/ast/call.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('ast.call', () => {
  it('bare string matches identifier call; object=null, property=null', async () => {
    const tree = await parseFile('x.js', 'eval("x");');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    const m = call(c, 'eval');
    expect(m).not.toBeNull();
    expect(m!.call).toBe(c);
    expect(m!.callee.type).toBe('identifier');
    expect(m!.object).toBeNull();
    expect(m!.property).toBeNull();
  });

  it('object form matches member call; object/property populated', async () => {
    const tree = await parseFile('x.js', 'fs.readFileSync("x");');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    const m = call(c, { object: 'fs', method: 'readFileSync' });
    expect(m).not.toBeNull();
    expect(m!.object?.text).toBe('fs');
    expect(m!.property?.text).toBe('readFileSync');
  });

  it('regex on method matches', async () => {
    const tree = await parseFile('x.js', 'this.useState();');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    expect(call(c, { method: /^use[A-Z]/ })).not.toBeNull();
  });

  it('regex on object matches', async () => {
    const tree = await parseFile('x.js', 'fileSystem.read();');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    expect(call(c, { object: /^file/, method: 'read' })).not.toBeNull();
  });

  it('name form matches bare-name call', async () => {
    const tree = await parseFile('x.js', 'parseInt("1");');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    expect(call(c, { name: 'parseInt' })).not.toBeNull();
    expect(call(c, { name: /^parse/ })).not.toBeNull();
    expect(call(c, { name: 'eval' })).toBeNull();
  });

  it('returns null when node is not call_expression', async () => {
    const tree = await parseFile('x.js', 'const x = 1;');
    const decl = tree.rootNode.descendantsOfType('lexical_declaration')[0];
    expect(call(decl, 'eval')).toBeNull();
  });

  it('returns null when target spec does not match', async () => {
    const tree = await parseFile('x.js', 'foo();');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    expect(call(c, 'bar')).toBeNull();
  });

  it('chained member — object matched against callee.object.text literally', async () => {
    const tree = await parseFile('x.js', 'a.b.c.method();');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    expect(call(c, { object: 'a', method: 'method' })).toBeNull();              // root NOT supported
    expect(call(c, { object: 'a.b.c', method: 'method' })).not.toBeNull();      // literal works
    expect(call(c, { object: /^a\./, method: 'method' })).not.toBeNull();       // regex works
  });

  it('callee is parenthesized expression (not identifier/member) → returns null', async () => {
    const tree = await parseFile('x.js', '(fn)();');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    // callee is a parenthesized_expression, not identifier or member_expression
    expect(call(c, 'fn')).toBeNull();
    expect(call(c, { name: 'fn' })).toBeNull();
  });

  it('object target with no match when object is null (bare name call) → null', async () => {
    const tree = await parseFile('x.js', 'foo();');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    // target.object specified but callee has no object (it is a bare identifier)
    expect(call(c, { object: 'foo' })).toBeNull();
  });

  it('method target with no match when property is null (bare name call) → null', async () => {
    const tree = await parseFile('x.js', 'bar();');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    // target.method specified but callee has no property (bare name)
    expect(call(c, { method: 'bar' })).toBeNull();
  });

  it('name target with no match when bareName is null (member call) → null', async () => {
    const tree = await parseFile('x.js', 'a.b();');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    // target.name specified but callee is a member (no bareName)
    expect(call(c, { name: 'a' })).toBeNull();
  });

  it('method target specified but property text does not match → null', async () => {
    const tree = await parseFile('x.js', 'fs.readFileSync("x");');
    const c = tree.rootNode.descendantsOfType('call_expression')[0];
    // property exists ('readFileSync') but spec 'writeFile' does not match
    expect(call(c, { method: 'writeFile' })).toBeNull();
  });
});
