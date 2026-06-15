---
id: cpp-same-basename-cross-dir-edge
language: cpp
category: trap
expectation: edge
cites: "[cpp.include]/5 (the includer's directory pins the resolved file); research A8 (same-basename across directories — the headline C/C++ trap)"
---

## Rule

The headline C/C++ false-positive trap: a header with the SAME basename exists in TWO
directories. `util.hpp` lives in both `app/` (beside the includer) and `lib/`. The
includer in `app/` does `#include "../lib/util.hpp"` — the full relative path climbs to
`lib/` and resolves to `lib/util.hpp` (node `lib`), NEVER the same-basename twin
`app/util.hpp` sitting right next to it. The canonical join pins the directory the path
names, so the leaf-name collision cannot mis-bind: the only way to reach `app/util.hpp`
is its own relative path `util.hpp`, which this include does not write.

## Files

```cpp path=app/util.hpp
#pragma once
struct AppUtil {};
```

```cpp path=lib/util.hpp
#pragma once
struct LibUtil {};
```

```cpp path=app/main.cpp
#include "../lib/util.hpp"
int main() { LibUtil u; return 0; }
```

## Expect

- app/main.cpp:1 -> node:lib      # `#include "../lib/util.hpp"` resolves to lib/util.hpp (node lib), never the same-basename app/util.hpp

## Why

The single most important C/C++ false-positive class. The identical basename in the
includer's own directory must NOT be chosen over the path the include actually writes;
the canonical join makes the same-basename twin structurally unreachable.
