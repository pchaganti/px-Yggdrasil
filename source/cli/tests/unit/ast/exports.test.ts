import { describe, it, expect } from 'vitest';
import { exports as exportsHelper } from '../../../src/ast/exports.js';
import { parseFile } from '../../../src/ast/parser.js';

describe('ast.exports', () => {
  it('named class export', async () => {
    const tree = await parseFile('x.ts', 'export class Foo {}');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('class');
    expect(d.name).toBe('Foo');
    expect(d.isDefault).toBe(false);
    expect(d.isReExport).toBe(false);
    expect(d.exportNode.type).toBe('export_statement');
    expect(d.node.type).toBe('class_declaration');
  });

  it('default class export → isDefault=true', async () => {
    const tree = await parseFile('x.ts', 'export default class Foo {}');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('class');
    expect(d.isDefault).toBe(true);
  });

  it('named function export → kind=function', async () => {
    const tree = await parseFile('x.ts', 'export function foo() {}');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('function');
    expect(d.name).toBe('foo');
    expect(d.isDefault).toBe(false);
  });

  it('default function with name → isDefault=true, name=foo', async () => {
    const tree = await parseFile('x.ts', 'export default function foo() {}');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('function');
    expect(d.isDefault).toBe(true);
    expect(d.name).toBe('foo');
  });

  it('default anonymous function → name=null', async () => {
    const tree = await parseFile('x.ts', 'export default function() {}');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('function');
    expect(d.isDefault).toBe(true);
    expect(d.name).toBeNull();
  });

  it('default anonymous class → name=null', async () => {
    const tree = await parseFile('x.ts', 'export default class {}');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('class');
    expect(d.isDefault).toBe(true);
    expect(d.name).toBeNull();
  });

  it('export const → kind=const', async () => {
    const tree = await parseFile('x.ts', 'export const x = 1;');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('const');
    expect(d.name).toBe('x');
  });

  it('export let → kind=let', async () => {
    const tree = await parseFile('x.ts', 'export let x = 1;');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('let');
  });

  it('export type → kind=type', async () => {
    const tree = await parseFile('x.ts', 'export type Foo = string;');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('type');
    expect(d.name).toBe('Foo');
  });

  it('export interface → kind=interface', async () => {
    const tree = await parseFile('x.ts', 'export interface Foo {}');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('interface');
    expect(d.name).toBe('Foo');
  });

  it('export enum → kind=enum', async () => {
    const tree = await parseFile('x.ts', 'export enum Foo { A }');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('enum');
    expect(d.name).toBe('Foo');
  });

  it('export namespace → kind=namespace', async () => {
    const tree = await parseFile('x.ts', 'export namespace Foo {}');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('namespace');
    expect(d.name).toBe('Foo');
  });

  it('export { x } from "./y" → kind=reexport, isReExport=true', async () => {
    const tree = await parseFile('x.ts', 'export { x } from "./y";');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('reexport');
    expect(d.isReExport).toBe(true);
  });

  it('export * from "./y" → kind=reexport, isReExport=true', async () => {
    const tree = await parseFile('x.ts', 'export * from "./y";');
    const [d] = exportsHelper(tree.rootNode);
    expect(d.kind).toBe('reexport');
    expect(d.isReExport).toBe(true);
  });
});
