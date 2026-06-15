---
id: cpp-module-import-std-silence
language: cpp
category: dynamic
expectation: silence
cites: "cppreference — `import std;` (C++23 standard-library module); research B2 (external std module — never a repo file) + Wall 2 (tree-sitter-cpp@0.23.4 misparses module syntax)"
---

## Rule

`import std;` imports the C++23 standard-library module, provided by the toolchain — an
EXTERNAL module, never an in-repo file, exactly like `<vector>`. Two independent walls
keep it silent: (1) a module name is decoupled from any file path — the name→file mapping
lives in the build system's module map / BMI, invisible to a source-only tool; and (2)
the bundled `tree-sitter-cpp@0.23.4` does not parse module syntax — it misparses
`import std;` as an ordinary declaration, indistinguishable from a real
declaration `import std;` (where `import` is a type and `std` a variable). The extractor
emits only quoted `#include`s, so a misparsed module declaration produces no specifier →
silence.

## Files

```cpp path=app/main.cpp
import std;
int main() { return 0; }
```

## Expect

- silence      # `import std;` is an external std-library module (and is misparsed by the bundled grammar) → no include emitted → no edge

## Why

A standard-library module is external like an angle include; emitting an edge for it
would be a false positive. The named-module form is also name-decoupled-from-path, so it
could not bind to a unique file even with perfect parsing.
