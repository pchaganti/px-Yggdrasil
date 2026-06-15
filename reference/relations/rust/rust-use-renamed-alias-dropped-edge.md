---
id: rust-use-renamed-alias-dropped-edge
language: rust
category: import
expectation: edge
cites: "Rust Reference — Use declarations (`as` renaming); research Form A7"
---

## Rule

A renamed `use crate::db::Repository as Repo;` changes only the LOCAL binding
name; the edge target is the path BEFORE `as`. The extractor reads the
`use_as_clause`'s `path` field and ignores the `alias`, so the dependency is on
`crate::db::Repository` (the item `Repository` in module `db`, file `src/db/mod.rs`),
never on the local name `Repo`.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/db/mod.rs
pub struct Repository;
```

```rust path=src/c/use.rs
use crate::db::Repository as Repo;
```

## Expect

- src/c/use.rs:1 -> node:db      # the alias `Repo` is dropped; target is the real path crate::db::Repository → src/db/mod.rs (node db)

## Why

The alias is a local rebinding, never a target. Stripping it and emitting the real
path keeps the edge pinned to the actual definition.
