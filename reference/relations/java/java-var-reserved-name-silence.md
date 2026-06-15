---
id: java-var-reserved-name-silence
language: java
category: trap
expectation: silence
cites: "JLS SE25 §14.4.1 (local variable type inference); research G3 (C38 in 06-14)"
---

## Rule

`var` is a reserved type NAME, not a keyword and not a type (JLS §14.4.1). `var x = 1;`
infers the type from the initializer; `var` itself is never a type reference. With no
import, the extractor emits nothing — and `var` MUST be excluded so no phantom `var`
edge is ever produced.

## Files

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m() { var x = 1; var s = "a"; }
}
```

## Expect

- silence      # `var` is a reserved type name, not a type → never an edge

## Why

Emitting an edge for `var` would be a phantom; it is a must-exclude token.
