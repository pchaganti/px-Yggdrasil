---
id: rust-inline-crate-type-position-edge
language: rust
category: usage-site
expectation: edge
cites: "Rust Reference — Paths in types (`crate::a::T` as a type); research Form C2 / inline type-position"
---

## Rule

A fully-qualified path written inline in a TYPE position — a field type
`f: crate::orders::Order` — parses as a `scoped_type_identifier` rooted at `crate`.
A `crate`/`self`/`super`-rooted path is shadow-free (absolute-within-crate or
relative-to-module), so it resolves deterministically through the module tree with
zero false positives, EVEN WITHOUT a `use`. Here `crate::orders::Order` resolves to
`src/orders/mod.rs` (Order is an item in module `orders`), node `orders`.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/orders/mod.rs
pub struct Order;
```

```rust path=src/c/types.rs
struct S {
    f: crate::orders::Order,
}
```

## Expect

- src/c/types.rs:2 -> node:orders      # inline type-position crate::orders::Order → src/orders/mod.rs (node orders)

## Why

A `crate`-rooted path has exactly one meaning; it cannot be a `use`-bound alias or
an external crate, so resolving it inline is as safe as resolving an import.
