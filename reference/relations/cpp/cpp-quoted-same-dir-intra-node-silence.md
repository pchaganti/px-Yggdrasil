---
id: cpp-quoted-same-dir-intra-node-silence
language: cpp
category: import
expectation: silence
cites: "[cpp.include]/5 (a bare quoted include resolves in the includer's own directory); research A1 + the node-granularity rule (same directory = one node → no cross-node edge)"
---

## Rule

A bare quoted `#include "sibling.hpp"` resolves by the canonical join to the includer's
OWN directory: from `app/main.cpp` it resolves to `app/sibling.hpp`. The header and the
includer share the directory, so they belong to the SAME node (`app`). The extractor
still emits the specifier and the resolver still resolves it to a real file — but a
dependency whose target node equals the source node is intra-node, never a cross-node
edge. Same-directory includes are silent at the relation-conformance granularity.

## Files

```cpp path=app/sibling.hpp
#pragma once
struct Sibling {};
```

```cpp path=app/main.cpp
#include "sibling.hpp"
int main() { Sibling s; return 0; }
```

## Expect

- silence      # `app/main.cpp` includes `app/sibling.hpp` — same directory, same node → no cross-node edge

## Why

The relation check reports cross-NODE dependencies; a header in the includer's own
directory maps to the same node, so resolving it produces no edge to declare — a
same-directory include is correctly invisible to the check.
