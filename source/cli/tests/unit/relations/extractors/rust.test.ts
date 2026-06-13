import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { rustExtractor } from '../../../../src/relations/extractors/rust.js';

const run = (code: string) => runExtractor(rustExtractor, 'rust', '.rs', code);

const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.targetHint.kind === 'path' ? [u.targetHint.specifier] : []));

describe('rust extractor — uses()', () => {
  it('detects a single `use crate::payments::charge;` as the crate-relative path hint', async () => {
    const { uses } = await run('use crate::payments::charge;');
    expect(uses).toContainEqual(
      expect.objectContaining({
        targetHint: { kind: 'path', specifier: 'crate::payments::charge' },
        kind: 'import',
      }),
    );
  });

  it('strips the alias of a renamed `use crate::db::Repository as Repo;`', async () => {
    const { uses } = await run('use crate::db::Repository as Repo;');
    const s = specs(uses);
    expect(s).toContain('crate::db::Repository');
    expect(s).not.toContain('Repo');
  });

  it('emits the common module prefix for a grouped `use crate::{a::Foo, b::Bar};`', async () => {
    // For existence the prefix module `crate` alone establishes the edge — both items
    // resolve under it. (Idiomatic grouped imports share a deeper prefix; see next.)
    const { uses } = await run('use crate::{a::Foo, b::Bar};');
    expect(specs(uses)).toEqual(['crate']);
  });

  it('emits the deeper common prefix for `use crate::orders::{Order, sub::Deep};`', async () => {
    const { uses } = await run('use crate::orders::{Order, sub::Deep};');
    expect(specs(uses)).toEqual(['crate::orders']);
  });

  it('emits the prefix module for a glob `use crate::events::*;`', async () => {
    const { uses } = await run('use crate::events::*;');
    expect(specs(uses)).toEqual(['crate::events']);
  });

  it('emits the path for a `pub use` re-export (visibility is irrelevant to the edge)', async () => {
    const { uses } = await run('pub use crate::api::Handler;');
    expect(specs(uses)).toEqual(['crate::api::Handler']);
  });

  it('keeps `super::` and `self::` roots verbatim in the specifier', async () => {
    expect(specs((await run('use super::util::X;')).uses)).toEqual(['super::util::X']);
    expect(specs((await run('use self::y::Z;')).uses)).toEqual(['self::y::Z']);
  });

  it('emits an external-crate path verbatim (the resolver, not the extractor, silences it)', async () => {
    const { uses } = await run('use std::collections::HashMap;');
    expect(specs(uses)).toEqual(['std::collections::HashMap']);
  });

  it('handles multiple use declarations in one file', async () => {
    const { uses } = await run(
      'use crate::a::A;\nuse crate::b::*;\nuse super::c::C as Cc;\n',
    );
    const s = specs(uses);
    expect(s).toEqual(
      expect.arrayContaining(['crate::a::A', 'crate::b', 'super::c::C']),
    );
    expect(s).toHaveLength(3);
  });

  it('never reaches into a macro invocation token tree (macro deps are invisible)', async () => {
    // A `crate::…` path appearing only inside a macro call is unparsed tokens, never a
    // use_declaration → zero hints.
    const { uses } = await run('fn f() {\n  println!("{}", crate::config::NAME);\n}\n');
    expect(specs(uses)).toEqual([]);
  });

  it('reports the line of each import', async () => {
    const { uses } = await run('\n\nuse crate::a::A;\n');
    expect(uses[0]?.line).toBe(3);
  });

  it('emits the common module prefix ONCE for two items in one group', async () => {
    // `use crate::orders::{Order, Other};` — both leaves share prefix `crate::orders`,
    // which is emitted a single time (the group emits the common prefix, not each leaf).
    const { uses } = await run('use crate::orders::{Order, Other};');
    expect(specs(uses)).toEqual(['crate::orders']);
    expect(uses).toHaveLength(1);
  });

  it('emits the prefix for a glob whose prefix is a PLAIN identifier `use foo::*;`', async () => {
    // The wildcard prefix `foo` is a bare `identifier` (not a `scoped_identifier`), so the
    // specifier is the node text `foo` — exercising the ELSE branch of the prefix render.
    const { uses } = await run('use foo::*;');
    expect(specs(uses)).toEqual(['foo']);
  });

  it('emits the prefix for a glob whose prefix is a `crate` keyword `use crate::*;`', async () => {
    const { uses } = await run('use crate::*;');
    expect(specs(uses)).toEqual(['crate']);
  });

  it('emits nothing for a leading-`::` absolute path `use ::foo::Bar;` (malformed prefix → silence)', async () => {
    // The leading `::` produces a scoped_identifier whose leftmost leaf has no `path`
    // field, so the path renderer cannot determine the first segment and returns nothing.
    const { uses } = await run('use ::foo::Bar;');
    expect(specs(uses)).toEqual([]);
  });

  it('falls back to emitting each list item when a group has NO common prefix `use ::{a, b};`', async () => {
    // A leading-`::` group has no usable prefix path, so the edge is preserved by emitting
    // each list item individually rather than being silently dropped.
    const { uses } = await run('use ::{a, b};');
    expect(specs(uses).sort()).toEqual(['a', 'b']);
  });

  it('dedups identical list items emitted from the prefix-less group fallback `use ::{a, a};`', async () => {
    // Both items render to `a` on the same line; the second is deduped (specifier+line key).
    const { uses } = await run('use ::{a, a};');
    expect(specs(uses)).toEqual(['a']);
    expect(uses).toHaveLength(1);
  });

  it('falls back to each item when the group prefix is an unrenderable scoped path `use ::foo::{Bar, Baz};`', async () => {
    // `::foo` renders to undefined (no leftmost segment), so the joined group prefix is
    // undefined → the fallback emits each item path (`Bar`, `Baz`) under an empty prefix.
    const { uses } = await run('use ::foo::{Bar, Baz};');
    expect(specs(uses).sort()).toEqual(['Bar', 'Baz']);
  });

  it('emits nothing for a glob whose prefix is an unrenderable scoped path `use ::foo::*;`', async () => {
    // The wildcard prefix `::foo` is a scoped_identifier that renders to undefined, so no
    // specifier is emitted (silence over a guess).
    const { uses } = await run('use ::foo::*;');
    expect(specs(uses)).toEqual([]);
  });

  it('resolves a renamed import via its `path` field only `use a as b;`', async () => {
    // The alias `b` is a local binding; the emitted specifier is the real path `a`.
    const { uses } = await run('use a as b;');
    expect(specs(uses)).toEqual(['a']);
  });

  it('emits nothing for a renamed import whose path is an unrenderable scoped path `use ::foo as bar;`', async () => {
    const { uses } = await run('use ::foo as bar;');
    expect(specs(uses)).toEqual([]);
  });

  it('keeps the `self` item of a group covered by the common prefix `use crate::a::{self, B};`', async () => {
    // The `self` leaf means the prefix module itself, already covered by `crate::a`.
    const { uses } = await run('use crate::a::{self, B};');
    expect(specs(uses)).toEqual(['crate::a']);
  });

  it('emits a bare top-level identifier import `use foo;`', async () => {
    // A non-grouped, non-scoped argument at the top level: empty prefix → the tail itself.
    const { uses } = await run('use foo;');
    expect(specs(uses)).toEqual(['foo']);
  });

  it('emits nothing for a glob with no prefix path `use ::*;`', async () => {
    // The wildcard has no prefix node (bare `*`), so there is nothing to emit.
    const { uses } = await run('use ::*;');
    expect(specs(uses)).toEqual([]);
  });

  it('ignores a bare top-level brace list with no prefix `use {a, b};`', async () => {
    // A bare `use {a, b};` parses with the brace list as the argument node directly; it is
    // not a recognised argument shape, so nothing is emitted (unhandled-argument case).
    const { uses } = await run('use {a, b};');
    expect(specs(uses)).toEqual([]);
  });

  it('emits the OUTER common prefix once for a nested group `use crate::a::{b::{C, D}, e};`', async () => {
    // The outer group`s common module prefix `crate::a` already covers every leaf and
    // nested group under it, so it is emitted exactly once — the nested `b::{C, D}` is not
    // separately descended.
    const { uses } = await run('use crate::a::{b::{C, D}, e};');
    expect(specs(uses)).toEqual(['crate::a']);
  });
});

describe('rust extractor — declarations()', () => {
  it('returns top-level struct / enum / trait / fn / mod names', async () => {
    const { declarations } = await run(
      'pub struct Order { id: u32 }\nenum E { A }\ntrait T {}\nfn f() {}\nmod m;\n',
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toEqual(expect.arrayContaining(['Order', 'E', 'T', 'f', 'm']));
  });

  it('does not descend into an inline `mod { … }` for nested items', async () => {
    const { declarations } = await run('mod inline { fn g() {} struct Inner {} }\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('inline');
    expect(keys).not.toContain('g');
    expect(keys).not.toContain('Inner');
  });

  it('ignores top-level items that are not struct/enum/trait/fn/mod (impl, const, static, use)', async () => {
    // Only the five named item kinds become declarations; an `impl` (no name), a `const`,
    // a `static`, and a `use` are all skipped by the item-type filter.
    const { declarations } = await run(
      'use crate::a;\nstruct S {}\nimpl S {}\nconst X: u32 = 1;\nstatic Y: u32 = 2;\n',
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toEqual(['S']);
  });

  it('reports the line of a top-level declaration', async () => {
    const { declarations } = await run('\nstruct Order {}\n');
    expect(declarations[0]?.symbolKey).toBe('Order');
    expect(declarations[0]?.line).toBe(2);
  });
});
