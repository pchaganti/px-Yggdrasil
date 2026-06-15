---
id: cpp-quoted-uppath-include-edge
language: cpp
category: import
expectation: edge
cites: "[cpp.include]/5 (quoted source-file search from the includer's directory); research A3 (up-path canonical join, with the over-climb guard)"
---

## Rule

A quoted up-path `#include "../core/engine.hpp"` climbs `../` out of the includer's
directory and then descends — `path.posix.join('app', '../core/engine.hpp')` normalizes
to `core/engine.hpp`. From `app/main.cpp` it resolves to `core/engine.hpp`, whose
owning node (`core`) differs from the includer's node (`app`): a real cross-node
dependency. A normalized result that escapes the repo root (`..`-prefixed) would be
rejected before any existence probe; this in-tree climb stays inside the repo and
resolves.

## Files

```cpp path=core/engine.hpp
#pragma once
struct Engine {};
```

```cpp path=app/main.cpp
#include "../core/engine.hpp"
int main() { Engine e; return 0; }
```

## Expect

- app/main.cpp:1 -> node:core      # `#include "../core/engine.hpp"` climbs to core/engine.hpp (node core)

## Why

The climb count plus the descend segment pin exactly one file; the escape guard
rejects any climb that leaves the repo root, so the up-path resolves as deterministically
as a same-directory include.
