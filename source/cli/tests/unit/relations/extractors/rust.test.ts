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
});
