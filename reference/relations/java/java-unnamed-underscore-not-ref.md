---
id: java-unnamed-underscore-not-ref
language: java
category: trap
expectation: silence
cites: "JEP 456 Unnamed Variables & Patterns (Java 22); JLS SE25; research G4 (NEW vs 06-14)"
---

## Rule

The underscore `_` is an UNNAMED variable (local / exception / lambda parameter) or an
unnamed pattern — it means "no name," NOT a type and NOT a reference. The grammar parses
`_` as `underscore_pattern`, never a `type_identifier` or `identifier`. With no import
and no usage-site analysis the extractor emits nothing; for any future usage-site walker,
`_` must never be read as a type or binding name.

## Files

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m() {
    for (var _ : new int[0]) {}
    try {} catch (Exception _) {}
  }
}
```

## Expect

- silence      # `_` is an unnamed variable/pattern, never a type → no hint

## Why

Reading `_` as a type or binding would be a phantom; it is a must-exclude token.
