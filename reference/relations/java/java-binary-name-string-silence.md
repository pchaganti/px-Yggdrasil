---
id: java-binary-name-string-silence
language: java
category: dynamic
expectation: silence
cites: "JLS SE25 §13.1 (binary names), §15.8.2; research D1''' (C21 in 06-14)"
---

## Rule

The `$` reflection/binary form (`com.acme.Outer$Inner`) appears ONLY in string
literals, e.g. `Class.forName("com.acme.Outer$Inner")`. Tree-sitter sees a
`string_literal`; the extractor walks only `import_declaration` and never inspects
string contents → no hint, no edge. Reflection is dynamic and unresolvable
source-only.

## Files

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m() throws Exception {
    Class<?> k = Class.forName("com.acme.Outer$Inner");
  }
}
```

## Expect

- silence      # the binary name lives in a string literal; no import_declaration → no hint

## Why

A reflection string is dynamic input the analyzer must not interpret as a type
reference.
