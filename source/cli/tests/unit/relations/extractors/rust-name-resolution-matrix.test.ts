import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { rustExtractor } from '../../../../src/relations/extractors/rust.js';
import {
  resolveRustPath,
  type RustResolveDeps,
} from '../../../../src/relations/extractors/rust-resolve.js';

/**
 * RUST USE-PATH IDENTIFICATION MATRIX — characterization, one `it()` per distinct Rust
 * `use` / path identification form. Each test realizes the CONCRETE source for that exact
 * case (with the `mod` declarations a real crate would carry to build the tree) and asserts
 * the SPEC-CORRECT, zero-FP outcome. Two layers are exercised: the EXTRACTOR (which
 * `::`-joined SPECIFIER a `use` declaration emits) and the RESOLVER (which repo-relative
 * `.rs` FILE a specifier maps to through the crate module tree). For every resolving PATH
 * form the same-LEAF / same-NAME FP-trap variant (a same-named module under a DIFFERENT
 * module path, or an external crate whose name collides with an in-repo module) sits beside
 * the positive.
 *
 * THE GROUP B (path-based) DECISION (.plans/2026-06-14-import-only-languages-decision.md):
 * Rust resolves a `use`/path through the CRATE MODULE TREE — built by `mod` declarations,
 * not a raw directory walk. `use crate::a::b::C` walks the tree rooted at the crate's `src/`;
 * `super::`/`self::` resolve relative to the importing file's module; a leading
 * `crate`/`super`/`self` (or the crate's own package name) is INTRA-crate, anything else
 * (`std`, `core`, `alloc`, a Cargo dependency like `serde`) is an EXTERNAL crate. It does NOT
 * resolve by namespace-relative simple-NAME binding, so the §-precedence simple-name trap
 * that drives the symbol languages does not apply. The FP risks are module-tree-resolution
 * -specific and Rust-shaped:
 *   - an EXTERNAL-crate path mis-read as in-repo (the leading-segment crate-vs-crate-relative
 *     distinction — the single most important guard; it must be by LEADING SEGMENT, never by
 *     whether a same-named `src/<seg>.rs` happens to exist),
 *   - a crate-relative path mis-mapped to the WRONG file via the module tree (a same-LEAF
 *     module under a different module path, chosen by leaf instead of full path),
 *   - a `super::` over-climb above the crate root, or a mis-climb to a same-named SIBLING in
 *     the wrong module,
 *   - a glob `use a::b::*` widening to per-item phantom edges,
 *   - a grouped `use a::b::{C, D}` emitting phantom leaf edges instead of the common module.
 * The cardinal invariant — ZERO false positives, a hard wall with no adopter waiver —
 * outranks recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * The zero-FP policy realized here:
 *   R1  Only a `use_declaration` is an edge. The emitted SPECIFIER is the `::`-joined
 *       crate-relative PATH; the local binding (alias `as D`, the `self` leaf of a group) is
 *       NEVER the target. A GROUPED `use a::b::{C, D}` emits the COMMON module prefix `a::b`
 *       ONCE (existence: every leaf resolves to the same file/node as the prefix module) — no
 *       per-leaf phantom. A GLOB `use a::b::*` emits the prefix module `a::b` — no per-item
 *       widening. Usage-site nodes (a fully-qualified call `crate::a::f()`, a trait impl, a
 *       type ref) never refine an edge (v1 enforces existence, not relation type) → no
 *       usage-site emission. `mod foo;` and `extern crate foo;` are NOT walked → no edge.
 *   R2  Resolution walks the CRATE MODULE TREE rooted at the crate's `src/` (discovered from
 *       the nearest Cargo.toml). `crate::a::b::C` probes longest-module-path first
 *       (`a/b/C.rs`, `a/b.rs`, `a.rs`), so the FULL path pins the file — a same-LEAF module
 *       elsewhere is structurally unreachable. The longest-match item fallback lets the final
 *       segment(s) be ITEMS inside a module file (or an INLINE `mod`), which is the correct
 *       owning file, never a phantom.
 *   R3  `super::`/`self::` resolve relative to the importing file's MODULE directory: `self::`
 *       against the file's own module, each `super::` climbs ONE module level. A climb above
 *       the crate `src/` root → SILENCE (never an out-of-crate file).
 *   R4  A path whose LEADING segment is not `crate`/`super`/`self` and not the crate's own
 *       package name is an EXTERNAL crate (`std`/`core`/`alloc`, any Cargo dependency) →
 *       SILENCE. This is by LEADING SEGMENT alone — a same-named in-repo `src/<seg>.rs` is
 *       NEVER chosen, so an external path can never mis-bind into our tree. This is the single
 *       most important false-positive guard.
 *   R5  candidate-parity invariant: every emitted reference is a ONE-ELEMENT candidate group
 *       (path languages never widen). Asserted at the end so the matrix can't break parity.
 *
 * PASS    → the extractor / resolver already does the spec-correct zero-FP thing (live `it`).
 * GAP     → a deliberate tolerated false-NEGATIVE (silence) per the decision doc (live `it`,
 *           asserting the silence; the suite stays green and documents the boundary). The
 *           usage-site forms (`mod foo;`, `extern crate`, a fully-qualified call) are GAPs.
 * SEALED  → a genuine current false-positive a matrix exposed and FIXED. This matrix exposed
 *           NO new genuine FP: the external-crate-vs-crate-relative distinction is by leading
 *           segment (never by file existence), the full-path module-tree walk pins the file
 *           (same-leaf unreachable), `super::` over-climb is silenced, and glob/grouped emit
 *           the common module only — so every live row is PASS / GAP and no seal was required.
 */

const run = (code: string) => runExtractor(rustExtractor, 'rust', '.rs', code);

/** The `::`-path specifiers emitted for a file — each `use_declaration`'s rendered path. */
const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

// A reusable resolver-deps fixture: crate `mycrate`, `src/` as the module-tree root, with a
// concrete in-repo module layout. Existence is checked against a fixed known-set keyed by
// repo-relative POSIX path. The same-LEAF traps are baked in:
//   crate::x  → src/x.rs        vs  crate::a::x → src/a/x.rs   (top-level vs nested, leaf `x`)
//   crate::a::sib → src/a/sib.rs vs crate::sib → src/sib.rs    (sibling vs top-level, leaf `sib`)
// `src/serde.rs` exists ON PURPOSE so the external-crate guard is proven NOT to be a file probe.
const KNOWN = new Set<string>([
  'src/lib.rs', // crate root module
  'src/a.rs', // module crate::a (file form)
  'src/a/b.rs', // module crate::a::b
  'src/a/b/deep.rs', // module crate::a::b::deep (submodule of b)
  'src/a/sib.rs', // module crate::a::sib (sibling of b)
  'src/a/x.rs', // module crate::a::x (leaf `x`, nested)
  'src/x.rs', // module crate::x (leaf `x`, top-level — the trap twin of a::x)
  'src/sib.rs', // module crate::sib (leaf `sib`, top-level — the trap twin of a::sib)
  'src/orders/mod.rs', // module crate::orders (mod.rs form)
  'src/serde.rs', // an in-repo module NAMED like the external crate `serde` (FP trap)
]);
const baseDeps: RustResolveDeps = {
  crateRootFor: () => ({ srcDir: 'src', crateName: 'mycrate' }),
};
const exists = (p: string) => KNOWN.has(p);
const R = (specifier: string, fromFile: string, deps: RustResolveDeps = baseDeps) =>
  resolveRustPath(specifier, fromFile, exists, deps);

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — crate-relative use (the `::`-path IS the edge; resolves through the module tree)', () => {
  it('PASS R1: `use crate::a::b::C;` → emits the crate-relative path `crate::a::b::C`', async () => {
    expect(specs((await run('mod a;\nuse crate::a::b::C;')).uses)).toEqual(['crate::a::b::C']);
  });

  it('PASS R2: `crate::a::b::C` resolves through the tree to `src/a/b.rs` (C is an item in module a::b)', () => {
    // Longest-module-path-first: `a/b/C.rs`(no), `a/b.rs`(YES). C is an item inside module a::b,
    // whose file is src/a/b.rs. The full path pins the directory chain.
    expect(R('crate::a::b::C', 'src/lib.rs')).toBe('src/a/b.rs');
  });

  it('PASS R2 (same-LEAF trap): `crate::x::Y` → `src/x.rs`, NEVER the nested `src/a/x.rs`', () => {
    // `crate::x` and `crate::a::x` share the LEAF `x` but are distinct module paths. Resolution
    // is by the FULL crate-relative path through the tree, not by the last segment, so the leaf
    // collision can never mis-bind — each path reaches ONLY its own file.
    expect(R('crate::x::Y', 'src/lib.rs')).toBe('src/x.rs');
  });

  it('PASS R2 (same-LEAF trap, twin): `crate::a::x::Y` → `src/a/x.rs`, NEVER the top-level `src/x.rs`', () => {
    expect(R('crate::a::x::Y', 'src/lib.rs')).toBe('src/a/x.rs');
  });

  it('PASS R2: the crate own NAME root `mycrate::a::b::C` is treated like `crate` → `src/a/b.rs`', () => {
    // 2018+ path-clarity: a path rooted at the crate's own package name resolves like `crate`.
    expect(R('mycrate::a::b::C', 'src/lib.rs')).toBe('src/a/b.rs');
  });

  it('PASS R2: a bare module path `crate::orders` (mod.rs form) → `src/orders/mod.rs`', () => {
    expect(R('crate::orders', 'src/lib.rs')).toBe('src/orders/mod.rs');
  });

  it('PASS R2: an INLINE submodule item `crate::a::sub::T` (sub is `mod sub {…}` in a.rs) → `src/a.rs`', () => {
    // `sub` has no file (`src/a/sub.rs` absent), so in valid Rust it can only be an INLINE module
    // declared inside a.rs. The longest-match falls back to a.rs — the correct owning file, NOT a
    // phantom. (This is the module-tree-vs-directory subtlety: the inline `mod` is invisible on
    // disk yet the owning FILE is still a.rs.)
    expect(R('crate::a::sub::T', 'src/lib.rs')).toBe('src/a.rs');
  });

  it('PASS R2: a fully-absent crate path `crate::nope::Thing` → SILENCE (no module file)', () => {
    expect(R('crate::nope::Thing', 'src/lib.rs')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — super:: / self:: (resolve relative to the importing file MODULE; mis-climb → SILENCE)', () => {
  it('PASS R1: `use super::sib::Y;` / `use self::deep::Z;` → keep the super/self root verbatim', async () => {
    expect(specs((await run('use super::sib::Y;')).uses)).toEqual(['super::sib::Y']);
    expect(specs((await run('use self::deep::Z;')).uses)).toEqual(['self::deep::Z']);
  });

  it('PASS R3: `super::sib::Y` from `src/a/b.rs` → `src/a/sib.rs` (climbs to module a, sibling sib)', () => {
    // From src/a/b.rs (module crate::a::b), one `super` is module crate::a. `sib` under a is
    // src/a/sib.rs. The same-leaf top-level src/sib.rs is NOT reachable from a single super-climb.
    expect(R('super::sib::Y', 'src/a/b.rs')).toBe('src/a/sib.rs');
  });

  it('PASS R3 (same-LEAF trap): two `super` climbs `super::super::sib::Y` from `src/a/b.rs` → top-level `src/sib.rs`', () => {
    // Two climbs reach the crate-root module; `sib` there is the TOP-LEVEL src/sib.rs. The number
    // of super-climbs selects which same-leaf `sib` — never a guess.
    expect(R('super::super::sib::Y', 'src/a/b.rs')).toBe('src/sib.rs');
  });

  it('PASS R3: `self::deep::Z` from `src/a/b.rs` → `src/a/b/deep.rs` (submodule of the own module)', () => {
    // `self` stays in module crate::a::b, whose submodule dir is src/a/b/; deep → src/a/b/deep.rs.
    expect(R('self::deep::Z', 'src/a/b.rs')).toBe('src/a/b/deep.rs');
  });

  it('PASS R3 (over-climb guard): `super::super::super::X` from `src/a/b.rs` → SILENCE (above the crate root)', () => {
    // Three climbs from module a::b would land above the crate `src/` root — an external/invalid
    // path. The withinSrc guard rejects it → silence, never an out-of-crate file.
    expect(R('super::super::super::X', 'src/a/b.rs')).toBeUndefined();
  });

  it('PASS R3 (root-module climb guard): `super::X` from `src/lib.rs` → SILENCE (crate root has no parent module)', () => {
    expect(R('super::X', 'src/lib.rs')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — external crates (std/core/alloc + Cargo deps → SILENCE; the leading-segment guard)', () => {
  it('PASS R1: `use std::collections::HashMap;` → emits the path verbatim (the RESOLVER silences it)', async () => {
    // The extractor cannot know `std` is external; it emits `std::collections::HashMap`. The
    // resolver gates it by the leading segment.
    expect(specs((await run('use std::collections::HashMap;')).uses)).toEqual([
      'std::collections::HashMap',
    ]);
  });

  it('PASS R4: `std::…` / `core::…` / `alloc::…` all resolve to SILENCE (compiler-provided crates)', () => {
    expect(R('std::collections::HashMap', 'src/lib.rs')).toBeUndefined();
    expect(R('core::mem::swap', 'src/lib.rs')).toBeUndefined();
    expect(R('alloc::vec::Vec', 'src/lib.rs')).toBeUndefined();
  });

  it('PASS R4: a Cargo dependency `serde::Deserialize` → SILENCE (leading segment is not the crate)', () => {
    expect(R('serde::Deserialize', 'src/lib.rs')).toBeUndefined();
  });

  it('PASS R4 (the critical FP trap — external name == in-repo module name): `serde::Foo` → SILENCE even though `src/serde.rs` EXISTS', () => {
    // The single most important zero-FP guard. `src/serde.rs` is a real in-repo module, AND the
    // crate depends on the external `serde` crate. The leading segment `serde` is NOT
    // `crate`/`super`/`self` and NOT the crate's own name (`mycrate`), so the path is EXTERNAL →
    // silence. The guard is by LEADING SEGMENT, never by probing `src/serde.rs` — so the external
    // path can NEVER mis-bind to the same-named in-repo file. (The in-repo module is reached only
    // by `crate::serde`, proven below.)
    expect(R('serde::Foo', 'src/lib.rs')).toBeUndefined();
  });

  it('PASS R2 (the in-repo twin IS reachable — only via `crate::`): `crate::serde::Foo` → `src/serde.rs`', () => {
    // The flip side of the trap: the in-repo `serde` module is a real dependency, reached ONLY by
    // its crate-relative path `crate::serde`. The external/in-repo distinction is exactly the
    // leading-segment rule — `serde::` external, `crate::serde::` in-repo.
    expect(R('crate::serde::Foo', 'src/lib.rs')).toBe('src/serde.rs');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — glob / aliased / grouped / nested (binding-shape never widens or phantoms)', () => {
  it('PASS R1: glob `use crate::events::*;` → emits the PREFIX module `crate::events` (no per-item widening)', async () => {
    // A glob brings every public item of the module into scope. The edge is on the MODULE; the
    // extractor emits the prefix once. There is no per-item enumeration (which would be phantom
    // edges to items that may not be separate files).
    expect(specs((await run('use crate::events::*;')).uses)).toEqual(['crate::events']);
  });

  it('PASS R1: glob `use crate::a::b::*;` resolves to the prefix module file `src/a/b.rs`, NOT widened', async () => {
    const s = specs((await run('use crate::a::b::*;')).uses);
    expect(s).toEqual(['crate::a::b']);
    expect(R(s[0], 'src/lib.rs')).toBe('src/a/b.rs');
  });

  it('PASS R1: aliased `use crate::db::Repository as Repo;` → target is the real path, alias dropped', async () => {
    const s = specs((await run('use crate::db::Repository as Repo;')).uses);
    expect(s).toEqual(['crate::db::Repository']);
    expect(s).not.toContain('Repo');
  });

  it('PASS R1: grouped `use crate::a::b::{C, D};` → the COMMON module prefix `crate::a::b` ONCE, no phantom leaves', async () => {
    // Both C and D are items/submodules of a::b → they resolve to the SAME file as the prefix
    // module. Emitting the common prefix once establishes the edge with no phantom per-leaf edge.
    const { uses } = await run('use crate::a::b::{C, D};');
    expect(specs(uses)).toEqual(['crate::a::b']);
    expect(uses).toHaveLength(1);
  });

  it('PASS R1: nested grouped `use crate::a::{b::{C, D}, e::F};` → the OUTER common prefix `crate::a` ONCE', async () => {
    // The outer group's common module prefix `crate::a` already covers every nested leaf and
    // group under it — emitted exactly once, never descended into per-item phantom edges.
    expect(specs((await run('use crate::a::{b::{C, D}, e::F};')).uses)).toEqual(['crate::a']);
  });

  it('PASS R1: a `self` group leaf `use crate::a::{self, B};` is covered by the common prefix `crate::a`', async () => {
    // The `self` leaf means the prefix module itself — already covered by `crate::a`. It is a
    // local re-binding, never a separate target.
    expect(specs((await run('use crate::a::{self, B};')).uses)).toEqual(['crate::a']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — pub use re-export (a real runtime dependency, resolves like `use`)', () => {
  it('PASS R1: `pub use crate::api::Handler;` → emits `crate::api::Handler` (visibility is irrelevant to the edge)', async () => {
    expect(specs((await run('pub use crate::api::Handler;')).uses)).toEqual(['crate::api::Handler']);
  });

  it('PASS R1: `pub use` resolves through the tree exactly like a private `use`', () => {
    // The re-export creates a real dependency on the re-exported path; resolution is identical.
    expect(R('crate::a::b::Handler', 'src/lib.rs')).toBe('src/a/b.rs');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — usage-site / non-use forms (deliberate tolerated recall GAPs, never an FP)', () => {
  it('GAP: a `mod foo;` declaration → emits NOTHING (extractor walks only `use_declaration`)', async () => {
    // `mod foo;` pulls foo.rs/foo/mod.rs into the tree — a real intra-crate file dependency. The
    // extractor does NOT treat a `mod` declaration as a dependency edge (it walks only
    // `use_declaration`), so this is a tolerated false-NEGATIVE. It can never mis-bind — no edge
    // is emitted at all. (Recall recommendation surfaced in the report, not auto-implemented.)
    expect(specs((await run('mod foo;')).uses)).toEqual([]);
  });

  it('PASS R1: an INLINE `mod foo { … }` → emits NOTHING (correct: same-file detail, no file dependency)', async () => {
    expect(specs((await run('mod foo { pub struct X; }')).uses)).toEqual([]);
  });

  it('GAP: an old-style `extern crate foo;` → emits NOTHING (external crate; never a use_declaration)', async () => {
    // `extern crate foo;` declares an external Cargo dependency — external anyway (it would
    // silence at the resolver). It is not a `use_declaration`, so the extractor emits nothing.
    // Correct on both counts: a missed external is no loss, and no in-repo edge can be fabricated.
    expect(specs((await run('extern crate foo;')).uses)).toEqual([]);
  });

  it('GAP: a fully-qualified call expression `crate::a::f()` (NOT a `use`) → emits NOTHING (usage-site)', async () => {
    // An inline fully-qualified path expression is a usage site, not a `use` import. v1 enforces
    // existence (the relation TYPE is not refined by usage sites), so the extractor performs no
    // usage-site refinement → no edge. A tolerated false-NEGATIVE.
    expect(specs((await run('fn g() { crate::a::f(); }')).uses)).toEqual([]);
  });

  it('PASS R1: a `crate::…` path appearing ONLY inside a macro invocation → emits NOTHING (macro tokens are unparsed)', async () => {
    // A path inside a `macro_invocation` token tree is unparsed tokens, never a use_declaration →
    // zero hints. Macro-generated deps are invisible by design (cannot be a guess = no FP).
    expect(specs((await run('fn f() {\n  println!("{}", crate::config::NAME);\n}\n')).uses)).toEqual(
      [],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — no-crate-root / malformed (no Cargo.toml ancestor or unrenderable path → SILENCE)', () => {
  it('PASS R4: a crate path with NO Cargo.toml ancestor → SILENCE (no module-tree root to anchor)', () => {
    const noCrate: RustResolveDeps = { crateRootFor: () => undefined };
    expect(R('crate::a::b::C', 'src/lib.rs', noCrate)).toBeUndefined();
  });

  it('PASS R3: a `super::` path with NO Cargo.toml ancestor → SILENCE (relative resolution still needs src/)', () => {
    const noCrate: RustResolveDeps = { crateRootFor: () => undefined };
    expect(R('super::sib::Y', 'src/a/b.rs', noCrate)).toBeUndefined();
  });

  it('PASS R1: a leading-`::` absolute path `use ::foo::Bar;` → emits NOTHING (unrenderable prefix, silence over a guess)', async () => {
    // The leading `::` yields a scoped_identifier whose leftmost leaf has no first segment, so the
    // path renderer returns undefined → no specifier emitted. Silence over a guess.
    expect(specs((await run('use ::foo::Bar;')).uses)).toEqual([]);
  });

  it('PASS R2: an empty specifier → SILENCE (no path segments to resolve)', () => {
    expect(R('', 'src/lib.rs')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — candidate-parity invariant (path languages emit ONE-ELEMENT groups, never widen)', () => {
  it('PASS R5: every emitted reference across mixed use forms is a one-element path group', async () => {
    const { uses } = await run(
      [
        'mod a;',
        'use crate::a::b::C;',
        'use crate::events::*;',
        'use crate::db::Repository as Repo;',
        'use crate::a::{b::{C, D}, e::F};',
        'use super::sib::Y;',
        'use self::deep::Z;',
        'use std::collections::HashMap;',
        'pub use crate::api::Handler;',
      ].join('\n'),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const dep of uses) {
      expect(dep.candidates).toHaveLength(1);
      expect(dep.candidates[0].kind).toBe('path');
    }
  });
});
