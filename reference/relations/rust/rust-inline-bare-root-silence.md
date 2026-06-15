---
id: rust-inline-bare-root-silence
language: rust
category: trap
expectation: silence
cites: "Rust Reference — Paths (2018+ bare leading segment is local-first / extern prelude); research Forms A13 / inline bare-root"
---

## Rule

An inline path NOT rooted at `crate`/`self`/`super` — a bare-identifier root like
`external::thing::Foo::bar()` — is NEVER emitted. A bare leading segment may be a
`use`-bound alias OR an external crate, an ambiguity a source-only tool must not
guess. Even though `src/external/mod.rs` (node `external`) is a real mapped module
whose name matches the leading segment, the inline bare-rooted call resolves to
NOTHING — the import or a `crate::`-qualified form would cover any real edge instead.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/external/mod.rs
pub struct Foo;
```

```rust path=src/c/run.rs
fn g() {
    external::thing::Foo::bar();
}
```

## Expect

- silence      # bare-identifier-rooted inline path; no edge to node:external even though src/external/mod.rs exists

## Why

Resolving a bare leading segment by probing `src/<seg>.rs` would let an external
crate (or a `use`-alias) mis-bind to a same-named in-repo module — the cardinal
false positive. Only `crate`/`self`/`super` roots are emitted inline.
