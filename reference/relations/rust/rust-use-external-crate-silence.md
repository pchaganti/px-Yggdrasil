---
id: rust-use-external-crate-silence
language: rust
category: trap
expectation: silence
cites: "Rust Reference — Preludes / extern prelude (std/core/Cargo deps external); research Form A5 (serde collision)"
---

## Rule

A `use` whose path's LEADING segment is not `crate`/`super`/`self` and not the
crate's own package name names an EXTERNAL crate (std, core, alloc, or any Cargo
dependency like `serde`). The extractor still emits the verbatim path
(`serde::Deserialize`), but the resolver silences it by the LEADING SEGMENT alone.
This is the cardinal false-positive guard: `serde::Deserialize` is external →
SILENCE *even though `src/serde/mod.rs` (node `serde`) exists in-repo*. The guard
never probes `src/serde.rs`, so an external path can never mis-bind to the
same-named in-repo module; that in-repo twin is reachable ONLY via `crate::serde`.

## Files

```toml path=Cargo.toml
[package]
name = "mycrate"
```

```rust path=src/serde/mod.rs
pub struct Deserialize;
```

```rust path=src/c/use.rs
use serde::Deserialize;
```

## Expect

- silence      # leading segment `serde` is external → no edge, even though the same-named in-repo node:serde exists

## Why

Deciding external-vs-crate by probing for a same-named in-repo file would be the
single worst false-positive source; the leading-segment rule keeps external paths
out of the in-repo tree unconditionally.
