import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { rubyExtractor } from '../../../../src/relations/extractors/ruby.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import type { ParsedFile, DetectedDep } from '../../../../src/relations/extractors/types.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { parseFile } from '../../../../src/ast/parser.js';

const run = (code: string) => runExtractor(rubyExtractor, 'ruby', '.rb', code);

const symbolKeys = (uses: DetectedDep[]): string[] =>
  uses.flatMap((u) => (u.targetHint.kind === 'symbol' ? [u.targetHint.symbolKey] : []));
const pathSpecs = (uses: DetectedDep[]): string[] =>
  uses.flatMap((u) => (u.targetHint.kind === 'path' ? [u.targetHint.specifier] : []));

async function parse(repoRel: string, code: string): Promise<ParsedFile> {
  ensureLoaderRegistered();
  const tree = await parseFile(repoRel, code);
  return { path: repoRel, content: code, tree, language: 'ruby' };
}

describe('ruby extractor — uses() emits PATH hints (require_relative)', () => {
  it('emits a path hint with the literal string for require_relative', async () => {
    const { uses } = await run("require_relative '../services/order_service'\n");
    expect(uses).toContainEqual(
      expect.objectContaining({
        targetHint: { kind: 'path', specifier: '../services/order_service' },
        kind: 'import',
      }),
    );
  });

  it('carries a 1-based line number for the require_relative hint', async () => {
    const { uses } = await run("\n\nrequire_relative './helper'\n");
    const hint = uses.find((u) => u.targetHint.kind === 'path');
    expect(hint?.line).toBe(3);
  });

  it('SKIPS a plain `require` of a gem (only require_relative is a path link)', async () => {
    const { uses } = await run("require 'json'\nrequire 'order/processor'\n");
    // Neither is a require_relative → no path hint at all.
    expect(pathSpecs(uses)).toHaveLength(0);
  });

  it('SKIPS require_relative with an interpolated / dynamic argument', async () => {
    const { uses } = await run('require_relative "../#{name}"\nrequire_relative File.join("a", "b")\n');
    expect(pathSpecs(uses)).toHaveLength(0);
  });
});

describe('ruby extractor — uses() emits SYMBOL hints (constants)', () => {
  it('emits the superclass constant for `class C < Base`', async () => {
    const { uses } = await run('class OrderService < BaseService\nend\n');
    expect(symbolKeys(uses)).toContain('BaseService');
    // The class\'s OWN name is a definition, never a dependency.
    expect(symbolKeys(uses)).not.toContain('OrderService');
  });

  it('emits a scope_resolution superclass key, stripping a leading `::`', async () => {
    const { uses } = await run('class A < Reporting::Base\nend\nclass B < ::Top::Base\nend\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('Reporting::Base');
    expect(keys).toContain('Top::Base'); // leading `::` stripped
    expect(keys.every((k) => !k.startsWith('::'))).toBe(true);
  });

  it('emits a symbol per `include` / `extend` / `prepend` module argument', async () => {
    const { uses } = await run(
      ['class C', '  include Loggable', '  extend Forwardable', '  prepend Tracing::Hook', 'end', ''].join('\n'),
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('Loggable');
    expect(keys).toContain('Forwardable');
    expect(keys).toContain('Tracing::Hook');
  });

  it('emits both constants for `include A, B` (multiple modules per call)', async () => {
    const { uses } = await run('class C\n  include A, B\nend\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('A');
    expect(keys).toContain('B');
  });

  it('emits a scope_resolution used as a value (`Foo::Bar`)', async () => {
    const { uses } = await run('x = Payments::Gateway\n');
    expect(symbolKeys(uses)).toContain('Payments::Gateway');
  });

  it('emits a bare constant used as a value (`x = Helper`)', async () => {
    const { uses } = await run('x = Helper\n');
    expect(symbolKeys(uses)).toContain('Helper');
  });

  it('emits the receiver constant of a qualified call (`Payments::Gateway.charge`)', async () => {
    const { uses } = await run('Payments::Gateway.charge(amount)\n');
    expect(symbolKeys(uses)).toContain('Payments::Gateway');
  });

  it('does NOT emit a symbol for a local-receiver call (`helper.run`, `@repo.save`)', async () => {
    const { uses } = await run('helper.run\n@repo.save(x)\nfoo.bar.baz\n');
    expect(symbolKeys(uses)).toHaveLength(0);
  });

  it('does NOT double-count the inner constants of a scope_resolution', async () => {
    const { uses } = await run('x = A::B::C\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('A::B::C');
    // The qualifier segments A and A::B must NOT each surface as their own hint.
    expect(keys).not.toContain('A');
    expect(keys).not.toContain('A::B');
    expect(keys.filter((k) => k === 'A::B::C')).toHaveLength(1);
  });
});

describe('ruby extractor — declarations() build FQNs from nesting', () => {
  it('builds App::Services::OrderService from module nesting', async () => {
    const { declarations } = await run(
      ['module App', '  module Services', '    class OrderService', '    end', '  end', 'end', ''].join('\n'),
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('App');
    expect(keys).toContain('App::Services');
    expect(keys).toContain('App::Services::OrderService');
  });

  it('records a top-level constant assignment as a definition', async () => {
    const { declarations } = await run('MAX = 5\nMyAlias = OriginalClass\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('MAX');
    expect(keys).toContain('MyAlias');
  });

  it('carries 1-based line numbers', async () => {
    const { declarations } = await run('\nclass Foo\nend\n');
    expect(declarations.find((d) => d.symbolKey === 'Foo')?.line).toBe(2);
  });

  it('a REOPENED class produces TWO definitions of the same FQN (no dedupe)', async () => {
    const { declarations } = await run('class Foo\nend\nclass Foo\nend\n');
    const fooDefs = declarations.filter((d) => d.symbolKey === 'Foo');
    expect(fooDefs).toHaveLength(2);
    // Different lines — two distinct definition sites of the same constant.
    expect(new Set(fooDefs.map((d) => d.line)).size).toBe(2);
  });
});

describe('ruby SYMBOL-TABLE resolution — unique resolves, reopened silences', () => {
  it('a UNIQUE constant resolves through the table to its defining file', async () => {
    const fileA = await parse('src/a/base_service.rb', 'class BaseService\nend\n');
    const consumer = await parse('src/b/order_service.rb', 'class OrderService < BaseService\nend\n');

    const st = new SymbolTable();
    for (const d of rubyExtractor.declarations(fileA)) st.declare(d.symbolKey, fileA.path);

    expect(st.resolveUnique('BaseService')).toBe('src/a/base_service.rb');

    const importHint = rubyExtractor.uses(consumer).find((u) => u.targetHint.kind === 'symbol')!;
    expect(importHint.targetHint).toEqual({ kind: 'symbol', symbolKey: 'BaseService' });

    const ownerIndex = { ownerOf: (f: string) => (f === 'src/a/base_service.rb' ? 'a' : undefined) };
    const resolver = makeResolver({
      ownerIndex: ownerIndex as never,
      symbolTable: st,
      resolvePathToFile: () => undefined,
    });
    expect(resolver.resolve(importHint.targetHint, consumer.path, 'ruby')).toEqual({
      ownerNode: 'a',
      resolvedFile: 'src/a/base_service.rb',
    });
  });

  it('a REOPENED (ambiguous) constant silences — resolveUnique undefined, no flag', async () => {
    // Two files each define `Widget` (reopening / same name across nodes) → ambiguous.
    const fileX = await parse('src/x/widget.rb', 'class Widget\nend\n');
    const fileY = await parse('src/y/widget.rb', 'class Widget\nend\n');
    const consumer = await parse('src/z/use.rb', 'x = Widget\n');

    const st = new SymbolTable();
    for (const f of [fileX, fileY]) {
      for (const d of rubyExtractor.declarations(f)) st.declare(d.symbolKey, f.path);
    }

    expect(st.resolveUnique('Widget')).toBeUndefined();

    const ownerIndex = { ownerOf: () => 'someNode' };
    const resolver = makeResolver({
      ownerIndex: ownerIndex as never,
      symbolTable: st,
      resolvePathToFile: () => undefined,
    });
    const hint = rubyExtractor.uses(consumer).find((u) => u.targetHint.kind === 'symbol')!;
    expect(resolver.resolve(hint.targetHint, consumer.path, 'ruby')).toBeUndefined();
  });
});

describe('ruby extractor — registry wiring', () => {
  it('declares the ruby language', () => {
    expect(rubyExtractor.languages.has('ruby')).toBe(true);
  });
});
