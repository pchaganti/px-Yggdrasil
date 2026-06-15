---
id: cpp-import-header-unit-silence
language: cpp
category: dynamic
expectation: silence
cites: "[cpp.include]/10 (an importable header may be replaced by an import) + cppreference — Modules (header units); research B5 (the one path-naming module form, but the bundled grammar misparses it as a concatenated_string expression)"
---

## Rule

`import "header.hpp";` is a header-unit import — the ONE module-era form whose operand is
a quoted header PATH (unlike a named module). In principle it could resolve by the same
canonical join as a quoted `#include`. BUT the bundled `tree-sitter-cpp@0.23.4` misparses
it as a `concatenated_string` EXPRESSION statement, not an `import` and not a
`preproc_include`, so the extractor never sees a path field for it. A real
`core/header.hpp` (node `core`) is present and `../core/header.hpp` would resolve to it —
yet because the parse never surfaces the path, the extractor emits nothing → silence. (It
is the only form that would become a safe recall edge IF a future grammar exposed its path
as a header-name node.)

## Files

```cpp path=core/header.hpp
#pragma once
struct Header {};
```

```cpp path=app/main.cpp
import "../core/header.hpp";
int main() { return 0; }
```

## Expect

- silence      # the header-unit import is misparsed as a string expression, not a preproc_include → no specifier emitted, even though core/header.hpp exists

## Why

The bundled grammar cannot expose the header-unit path, so the extractor emits nothing;
keying an edge on the misparsed expression would be unsafe (indistinguishable from
ordinary C++), so silence is the only zero-FP outcome today.
