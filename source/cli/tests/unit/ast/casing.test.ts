import { describe, it, expect } from 'vitest';
import { casing } from '../../../src/ast/casing.js';

describe('ast.casing', () => {
  it('pascal: positive cases', () => {
    expect(casing.pascal('FooBar')).toBe(true);
    expect(casing.pascal('Foo')).toBe(true);
    expect(casing.pascal('F')).toBe(true);
  });
  it('pascal: negative cases', () => {
    expect(casing.pascal('fooBar')).toBe(false);
    expect(casing.pascal('FOO_BAR')).toBe(false);
    expect(casing.pascal('foo-bar')).toBe(false);
  });
  it('camel: positive cases', () => {
    expect(casing.camel('fooBar')).toBe(true);
    expect(casing.camel('foo')).toBe(true);
  });
  it('camel: negative cases', () => {
    expect(casing.camel('FooBar')).toBe(false);
    expect(casing.camel('foo_bar')).toBe(false);
  });
  it('upperSnake: positive cases', () => {
    expect(casing.upperSnake('FOO_BAR')).toBe(true);
    expect(casing.upperSnake('FOO')).toBe(true);
    expect(casing.upperSnake('F')).toBe(true);
  });
  it('upperSnake: negative cases', () => {
    expect(casing.upperSnake('fooBar')).toBe(false);
    expect(casing.upperSnake('FooBar')).toBe(false);
  });
  it('kebab: positive cases', () => {
    expect(casing.kebab('foo-bar')).toBe(true);
    expect(casing.kebab('foo')).toBe(true);
  });
  it('kebab: negative cases', () => {
    expect(casing.kebab('FooBar')).toBe(false);
    expect(casing.kebab('foo_bar')).toBe(false);
  });
});
