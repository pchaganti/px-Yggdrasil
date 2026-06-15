---
id: cpp-macro-operand-include-silence
language: cpp
category: dynamic
expectation: silence
cites: "[cpp.include]/7 (the macro-expanded third include form is reprocessed after macro replacement); research A5 (the expanded path is unknowable without running the preprocessor → SILENCE)"
---

## Rule

The macro-operand `#include HDR` is the third include form: the tokens after `include`
are macro-replaced, then must form a header-name. The actual path is whatever the macro
expands to — knowable ONLY by running the preprocessor, which a source-only analyzer does
not do. The include's path field is an `identifier` (`HDR`), not a `string_literal`, so
the emission gate emits nothing. Even with `#define HDR "../core/x.hpp"` present (and a
real `core/x.hpp` that the expanded path WOULD resolve to), the extractor never expands
macros, so it emits no specifier and the include stays silent — never a guess at the
expanded path.

## Files

```cpp path=core/x.hpp
#pragma once
struct X {};
```

```cpp path=app/main.cpp
#define HDR "../core/x.hpp"
#include HDR
int main() { return 0; }
```

## Expect

- silence      # `#include HDR` has an identifier path (no string literal) → emitted as nothing; the macro is never expanded, so core/x.hpp is never reached

## Why

Emitting any guess at the macro-expanded path would be a false positive; the expanded
path is unknowable from source, so silence is the only zero-FP option for the macro-include
idiom.
