---
id: rust-macro-invocation-path-silence
language: rust
category: dynamic
expectation: silence
cites: "Rust Reference — Macros (token trees / transcribers); research Form D6"
---

## Rule

A path appearing ONLY inside a `macro_invocation` token tree is UNPARSED tokens — the
walk never descends into a macro's `token_tree` to find a `use_declaration` or a
crate-relative path, and the macro may not even expand to a real reference. So
`crate::config::NAME` written inside `println!(…)` emits NOTHING, even though
`src/config/mod.rs` (node `config`) is a real mapped module. Macro-generated
dependencies are invisible by design — they cannot be guessed, so they cannot be a
false positive.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/config/mod.rs
pub const NAME: &str = "x";
```

```rust path=src/c/run.rs
fn f() {
    println!("{}", crate::config::NAME);
}
```

## Expect

- silence      # the crate::config::NAME path lives inside macro tokens → no edge to node:config

## Why

Macro token trees are unparsed; attributing an edge from inside one would be a guess
over invisible expansion — the under-detect direction is the only safe one.
