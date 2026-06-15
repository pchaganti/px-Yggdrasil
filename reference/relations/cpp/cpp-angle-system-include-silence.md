---
id: cpp-angle-system-include-silence
language: cpp
category: builtin
expectation: silence
cites: "[cpp.include]/4 (angle form = header search through the implementation-defined -I path); research A4 (angle includes are silenced AT EMISSION, never a same-name file probe)"
---

## Rule

An angle `#include <ext/widget.hpp>` is a HEADER search through the implementation-defined
`-I`/system path — the operand names a header, not a repo-relative source file. The
extractor's path field for an angle include is a `system_lib_string`, not a
`string_literal`, so the emission gate emits NOTHING; the angle path never reaches the
resolver. This is a same-name FP trap: an in-repo `app/ext/widget.hpp` (node `ext`) is
deliberately present, and the canonical join `app/ext/widget.hpp` from the includer in
`app/` WOULD resolve to node `ext` if the angle path ever reached the resolver. Because
the guard is at emission, the same-named in-repo file is structurally unreachable through
the angle directive — no edge can be fabricated.

## Files

```cpp path=app/ext/widget.hpp
#pragma once
struct Widget {};
```

```cpp path=app/main.cpp
#include <ext/widget.hpp>
int main() { return 0; }
```

## Expect

- silence      # `#include <ext/widget.hpp>` is an angle include → emitted as nothing, even though app/ext/widget.hpp exists in-repo

## Why

The angle guard is at EMISSION, not a file probe: a system or third-party header reached
by `<...>` is never a repo dependency in this model, so even an in-repo file that shares
the name can never be flagged.
