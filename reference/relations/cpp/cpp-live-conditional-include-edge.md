---
id: cpp-live-conditional-include-edge
language: cpp
category: import
expectation: edge
cites: "[cpp.cond] (conditional inclusion); research D2 (a non-`0` conditional include is a real dependency under some configuration → KEPT)"
---

## Rule

Every preprocessor conditional EXCEPT the literal `#if 0` / `#elif 0` MAY be compiled
under some configuration, so an `#include` inside it is a legitimate conditional
dependency the tool keeps. A source-only analyzer cannot evaluate macro state, so it
does not drop a live conditional — `#ifdef FEATURE` is a `preproc_ifdef` (no condition
field, never literal-`0`). The wrapped `#include "../plugins/audio.hpp"` from
`app/main.cpp` resolves to `plugins/audio.hpp` (node `plugins`) exactly as an
unconditional include would: the conditional only gates compilation, not resolution.

## Files

```cpp path=plugins/audio.hpp
#pragma once
struct Audio {};
```

```cpp path=app/main.cpp
#ifdef FEATURE
#include "../plugins/audio.hpp"
#endif
int main() { return 0; }
```

## Expect

- app/main.cpp:2 -> node:plugins      # `#include` under `#ifdef FEATURE` is a live conditional dep → plugins/audio.hpp (node plugins)

## Why

`#if 0` is the ONLY conditional a hermetic tool can resolve as dead with certainty;
every other conditional is real under at least one configuration, so keeping the include
is the spec-correct, zero-FP choice — a missed live dependency would be the only failure
mode, and that is avoided by emitting.
