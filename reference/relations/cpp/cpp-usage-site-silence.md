---
id: cpp-usage-site-silence
language: cpp
category: usage-site
expectation: silence
cites: "research C1–C4 (call binds at LINK time; inheritance / `ns::Type` / `using` bind by NAME via name lookup, not to a source-named file)"
---

## Rule

Every C/C++ usage site binds by NAME at compile/link time, not to a file the source
names: a function call (`g()`) binds at LINK time to whatever TU defines the symbol; a
base class (`class D : public Base`), a namespace-qualified reference (`ns::Type`), and a
`using ns::Type;` declaration all bind by name lookup over names some header already
brought into scope. None is a file reference, so none is an edge for a hermetic,
source-only tool. The genuine in-repo dependency, when real, is idiomatically already
introduced by an `#include` of the declaring header (the edge) — refining a usage site
would only re-derive that or manufacture a same-name FP. This file references `Base`,
`ns::Type`, `g()`, and `using ns::Type` — all defined in a SIBLING node `lib/` — but
writes NO `#include`, so the extractor emits nothing → silence.

## Files

```cpp path=lib/base.hpp
#pragma once
struct Base {};
namespace ns { struct Type {}; }
void g();
```

```cpp path=app/main.cpp
using ns::Type;
struct D : public Base {};
void use() { ns::Type t; g(); }
```

## Expect

- silence      # call / inheritance / `ns::Type` / `using` are usage sites that bind by name, not by file path — and there is no `#include` → no edge

## Why

A usage site never names a file; resolving one would require a cross-node definition index
plus overload/template resolution this layer does not build, and a same-named symbol in
another node would mis-bind — so the import-only floor silences every usage site, losing
no edge the corresponding `#include` would not already express.
