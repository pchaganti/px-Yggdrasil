---
id: java-multi-catch-usage-silence
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §14.20, §6.5.5; research F16 (C32 in 06-14)"
---

## Rule

A multi-catch `catch (A | B e)` holds each caught type in a TYPE position. Fully-qualified
catch types are `scoped_type_identifier`s, shadow-free per §6.5.5.2, so the extractor
emits a SYMBOL hint for each that resolves like an import → a real cross-node edge.
`catch (com.acme.err.E1 | com.acme.err.E2 e)` references two types; both live in node
`err`, so the two refs deduplicate to a single edge on that line.

## Files

```java path=src/main/java/com/acme/err/E1.java
package com.acme.err;
public class E1 extends Exception {}
```

```java path=src/main/java/com/acme/err/E2.java
package com.acme.err;
public class E2 extends Exception {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m() {
    try {} catch (com.acme.err.E1 | com.acme.err.E2 e) {}
  }
}
```

## Expect

- src/main/java/com/app/C.java:4 -> node:err      # multi-catch `com.acme.err.E1 | com.acme.err.E2` both fully-qualified → edge (node err)

## Why

Fully-qualified catch types are shadow-free, so they resolve like imports — a real
cross-node edge; both caught types share node `err`, so one edge stands for the line.
