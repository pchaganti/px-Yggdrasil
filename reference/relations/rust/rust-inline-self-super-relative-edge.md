---
id: rust-inline-self-super-relative-edge
language: rust
category: usage-site
expectation: edge
cites: "Rust Reference — Paths (`self`/`super` qualifiers); research Forms A2/A3 / inline self+super"
---

## Rule

Inline `self::`- and `super::`-rooted paths resolve relative to the importing file's
MODULE, exactly like the crate-rooted inline forms — they are shadow-free
relative-to-module markers. From `src/feature/mod.rs` (module `crate::feature`,
module dir `src/feature`), a type-position `self::widget::W` resolves to the
directory-form submodule `src/feature/widget/mod.rs` (node `widget`). From the same
file, an expression-position `super::shared::run()` climbs one module level to the
crate root and resolves `shared` to `src/shared/mod.rs` (node `shared`). Both cross a
node boundary.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/feature/widget/mod.rs
pub struct W;
```

```rust path=src/shared/mod.rs
pub fn run() {}
```

```rust path=src/feature/mod.rs
struct S {
    f: self::widget::W,
}
fn g() {
    super::shared::run();
}
```

## Expect

- src/feature/mod.rs:2 -> node:widget      # inline type-position self::widget::W → src/feature/widget/mod.rs (node widget)
- src/feature/mod.rs:5 -> node:shared      # inline expression-position super::shared::run → src/shared/mod.rs (node shared)

## Why

`self`/`super` are module-relative and shadow-free; the climb count and own-module
anchor pin the exact target file, so inline relative paths resolve as safely as a
`use`.
