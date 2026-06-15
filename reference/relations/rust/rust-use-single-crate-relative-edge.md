---
id: rust-use-single-crate-relative-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Use declarations (`use crate::a::b::C`); research Form A1"
---

## Rule

A simple `use crate::a::b::C;` creates a local binding `C` for the item at the
crate-relative path `crate::a::b::C`. The leading `crate` anchors the path at the
current crate root (the `src/` discovered from the nearest `Cargo.toml`); the
`::`-joined path resolves through the module tree, longest-module-path first. `C`
is an item in module `a::b`, whose file is `src/a/b.rs`, so the import is a real
dependency on the node owning that file. The full path pins the directory chain —
a same-leaf module elsewhere is structurally unreachable.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/a/b.rs
pub struct C;
```

```rust path=src/c/use.rs
use crate::a::b::C;
```

## Expect

- src/c/use.rs:1 -> node:a      # `use crate::a::b::C` resolves through the tree to src/a/b.rs (node a)

## Why

Binding by the FULL crate-relative path is the safe direction: the path names
exactly one module file, so a coincidental same-leaf module under a different
module path can never be chosen.
