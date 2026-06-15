---
id: rust-use-grouped-common-prefix-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Use declarations (nested/grouped `use a::b::{C, D}`); research Form A9"
---

## Rule

A grouped `use crate::a::b::{C, D};` imports multiple entities from the preceding
module. Every leaf (`C`, `D`) is an item or submodule of `a::b`, so each resolves
to the SAME file/node as the prefix module. The extractor emits the COMMON module
prefix `crate::a::b` ONCE (file `src/a/b.rs`) — never a per-leaf phantom edge.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/a/b.rs
pub struct C;
pub struct D;
```

```rust path=src/c/use.rs
use crate::a::b::{C, D};
```

## Expect

- src/c/use.rs:1 -> node:a      # the COMMON prefix crate::a::b → src/a/b.rs (node a), emitted once for the whole group

## Why

Per-leaf phantom edges (`crate::a::b::C`, `crate::a::b::D`) would over-count and
could mis-resolve a leaf to a non-existent submodule file. The common module prefix
is the exact, single dependency.
