---
id: cpp-nonexistent-quoted-include-silence
language: cpp
category: import
expectation: silence
cites: "[cpp.include]/5 (a failed quoted search falls back to the angle header search — i.e. an unseen -I root); research A7 (the cardinal false-positive guard: no speculative root walk)"
---

## Rule

A quoted `#include "../core/missing.hpp"` whose canonical join does not exist on disk is
SILENCED, not guessed. The extractor emits the specifier (it cannot know existence); the
resolver joins it to the includer's directory (`core/missing.hpp`), finds no such file,
and — critically — does NOT probe speculative `-I` roots (ancestor dirs / `include/`
subdirs). A header reachable only through an unseen compiler `-I` flag stays silent: an
ancestor probe could only ever grab a same-basename DECOY the compiler would not pick,
which would manufacture a false dependency. The `core/` directory exists (it holds an
unrelated header) but `missing.hpp` does not, so the join misses → silence.

## Files

```cpp path=core/present.hpp
#pragma once
struct Present {};
```

```cpp path=app/main.cpp
#include "../core/missing.hpp"
int main() { return 0; }
```

## Expect

- silence      # `core/missing.hpp` does not exist; the canonical join misses and there is no speculative search → no edge

## Why

This is the single most important false-positive guard for C/C++: probing alternative
roots to "find" a missing header could only match a same-basename decoy, so a resolution
miss is silenced and the missed -I-only header is a tolerated false-negative.
