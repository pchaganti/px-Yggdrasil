---
id: cpp-quoted-subpath-include-edge
language: cpp
category: import
expectation: edge
cites: "[cpp.include]/5 (quoted source-file search begins in the including file's directory); research A2"
---

## Rule

A quoted `#include "sub/foo.hpp"` is the ONLY edge-bearing C/C++ form: its operand is
a literal relative path, resolved by the canonical join `<dir-of-includer>/<headerPath>`,
normalized. A sub-path descends into a child directory of the includer. From
`app/main.cpp` the include `detail/helper.hpp` resolves to `app/detail/helper.hpp` — a
file whose owning node (`detail`) differs from the includer's node (`app`), so the
quoted include is a real cross-node dependency. The full relative path pins the
directory chain, so a same-basename header elsewhere is structurally unreachable.

## Files

```cpp path=app/detail/helper.hpp
#pragma once
struct Helper {};
```

```cpp path=app/main.cpp
#include "detail/helper.hpp"
int main() { Helper h; return 0; }
```

## Expect

- app/main.cpp:1 -> node:detail      # `#include "detail/helper.hpp"` joins under app/ → app/detail/helper.hpp (node detail)

## Why

The canonical quoted-include join is pure path arithmetic under the includer's
directory; the full relative path names exactly one file, so a same-basename header in
another directory can never be mis-chosen.
