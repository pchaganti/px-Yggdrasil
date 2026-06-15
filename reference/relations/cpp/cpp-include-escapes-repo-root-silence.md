---
id: cpp-include-escapes-repo-root-silence
language: cpp
category: import
expectation: silence
cites: "research D2 (path normalization rejects any include whose canonical join climbs above the repository root — a hermetic tool never resolves outside the analyzed tree)"
---

## Rule

A quoted include whose canonical `../`-join climbs ABOVE the repository root is rejected by
the resolver's path normalization: a normalized path that begins with `..` has escaped the
tree, so resolution returns nothing → silence. The resolver never binds a file outside the
repository, so an over-climbing `../`-chain can never resolve to an in-repo header — neither
relative to the including file nor against any include root.

## Files

```cpp path=app/main.cpp
#include "../../../escape.hpp"
int main() { return 0; }
```

## Expect

- silence      # the include canonically climbs above the repo root → rejected by path normalization → no edge

## Why

Resolving above the repository root would step outside the analyzed tree and could not
correspond to a mapped node anyway; rejecting an escaping include is the spec-correct,
zero-false-positive behavior.
