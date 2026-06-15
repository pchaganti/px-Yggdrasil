---
id: cpp-export-module-decl-silence
language: cpp
category: dynamic
expectation: silence
cites: "cppreference — Modules (C++20: `export module foo;` declares the current TU's module identity); research B3 (declaration axis, not a dependency edge) + Wall 2 (misparses/ERRORs)"
---

## Rule

`export module foo;` DECLARES the current translation unit's own module identity — it is
the TARGET side (the analogue of a package declaration), not a dependency EDGE to another
file. It introduces no `#include` and names no other file to depend on. The bundled
`tree-sitter-cpp@0.23.4` additionally misparses it into an ordinary declaration with an
`ERROR` node. Either way the extractor — which emits only quoted `#include`s — produces no
specifier, so the module declaration is silent.

## Files

```cpp path=app/widget.cpp
export module foo;
export struct Widget {};
```

## Expect

- silence      # `export module foo;` declares this file's own module identity (target axis, not an edge) → no include → no edge

## Why

A module declaration is the declaration axis, not an outgoing dependency, so it can never
be a cross-node edge — and the bundled grammar cannot parse it anyway. Both grounds make
silence the only correct outcome.
