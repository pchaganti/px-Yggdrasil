---
id: cpp-dead-if-zero-else-live-edge
language: cpp
category: import
expectation: edge
cites: "[cpp.cond] (the #else of a false #if IS compiled); research D1 (branch precision — only the dead body is skipped, the live #else/alternative is kept)"
---

## Rule

A literal `#if 0` is statically dead, but its `#else` (`alternative`) branch IS compiled.
The extractor's dead-branch guard checks whether the include sits under the conditional's
`alternative` field: when it does (the live `#else`), the include is NOT in the dead body,
so the seal does not fire and the include IS emitted. A `#if 0 … #else #include "x" #endif`
therefore keeps the `#else` include as a real dependency — only the dead `#if 0` body is
skipped. This is the branch precision that stops the dead-branch seal from over-suppressing.

## Files

```cpp path=core/live.hpp
#pragma once
struct Live {};
```

```cpp path=app/main.cpp
#if 0
#else
#include "../core/live.hpp"
#endif
int main() { return 0; }
```

## Expect

- app/main.cpp:3 -> node:core      # the `#include` is under the LIVE `#else` of a dead `#if 0` → emitted (only the dead body is skipped)

## Why

Skipping the `#else` of a `#if 0` would drop a real dependency — the `#else` is exactly
what the compiler keeps when the `#if 0` is false. Dead body skipped, live alternative
kept: branch precision is what keeps the seal zero-false-positive without over-suppressing.
