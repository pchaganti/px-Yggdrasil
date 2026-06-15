---
id: cpp-module-partition-silence
language: cpp
category: dynamic
expectation: silence
cites: "cppreference — Modules (C++20 module partitions `export module foo:part;`); research B7 (partitions are intra-module, the partition→file mapping is build-system-defined; the bundled grammar ERRORs/misparses)"
---

## Rule

A module partition declaration `export module foo:part;` names a partition of the current
module — an INTRA-module subdivision whose partition→file mapping is defined by the build
system, never by source. It introduces no `#include` and names no in-repo file path to
depend on. The bundled `tree-sitter-cpp@0.23.4` misparses it into an ordinary declaration
with `ERROR` nodes. The extractor — quoted `#include`s only — emits nothing, so the
partition form is silent.

## Files

```cpp path=app/part.cpp
export module foo:part;
export struct Part {};
```

## Expect

- silence      # `export module foo:part;` is an intra-module partition declaration (build-system mapping, and a grammar ERROR) → no include → no edge

## Why

The partition→file mapping lives in the build graph, invisible to a hermetic tool, so no
partition form can bind to a unique file at zero FP — and the bundled grammar cannot parse
it. Silence on both grounds.
