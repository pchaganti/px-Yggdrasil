---
id: rust-use-glob-prefix-module-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Use declarations (glob `use a::b::*`); research Form A6"
---

## Rule

A glob `use crate::a::b::*;` brings every public item of the prefix module into
scope. The dependency is on the MODULE, not on any enumerated item: the extractor
emits the prefix `crate::a::b` ONCE, which resolves to the module file `src/a/b.rs`.
Per-item widening is forbidden (items may not be separate files — that would
fabricate phantom edges).

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
use crate::a::b::*;
```

## Expect

- src/c/use.rs:1 -> node:a      # the glob prefix module crate::a::b → src/a/b.rs (node a); no per-item widening

## Why

Attributing the edge to the prefix module is exact; enumerating per-item phantoms
over-detects against items that have no separate file.
