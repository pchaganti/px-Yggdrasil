---
id: rust-mod-decl-file-backed-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Modules (non-inline `mod foo;` loads foo.rs / foo/mod.rs); research Form D1"
---

## Rule

A file-backed `mod foo;` (a `mod_item` with NO body) pulls the child module's file
into the crate module tree — `foo.rs` or `foo/mod.rs` beside the declaring file's
module — a real intra-crate FILE dependency. It is emitted as the relative path
`self::foo`, resolved through the module tree exactly like a `self::` import. Here
`src/orders/mod.rs` (module `crate::orders`) declares `mod foo;`, and `foo` lives in
the directory form `src/orders/foo/mod.rs` — a file whose owning node (`foo`) differs
from the declaring node (`orders`), so the structural dependency crosses a node
boundary.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/orders/foo/mod.rs
pub struct X;
```

```rust path=src/orders/mod.rs
mod foo;
```

## Expect

- src/orders/mod.rs:1 -> node:foo      # `mod foo;` → self::foo → src/orders/foo/mod.rs (node foo), a structural intra-crate file dependency

## Why

`mod foo;` is the mechanism that builds the module tree the `use` resolver walks.
Its target is always an in-crate file by construction (never external), with a
deterministic, zero-FP conventional location — so emitting the `self::foo` edge is
a recall gain with no new false-positive surface.
