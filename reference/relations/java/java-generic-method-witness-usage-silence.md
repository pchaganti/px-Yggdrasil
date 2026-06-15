---
id: java-generic-method-witness-usage-silence
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §15.12, §8.4.4; research F18 (C34 in 06-14)"
---

## Rule

An explicit generic method type witness `Collections.<com.acme.model.Foo>emptyList()`
carries the witness type inside `<…>` — a TYPE position. A fully-qualified witness is a
`scoped_type_identifier`, shadow-free per §6.5.5.2, so the extractor emits a SYMBOL hint
that resolves like an import → a real cross-node edge to node `model`. The invocation
qualifier `java.util.Collections` is in EXPRESSION position (a method-invocation chain,
not a `scoped_type_identifier`), and resolves to no in-repo file regardless → silence.

## Files

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m() {
    var l = java.util.Collections.<com.acme.model.Foo>emptyList();
  }
}
```

## Expect

- src/main/java/com/app/C.java:4 -> node:model      # explicit type witness `com.acme.model.Foo` is shadow-free → real edge (node model)

## Why

A fully-qualified method type witness sits in a TYPE position and is shadow-free, so it
resolves like an import — a real cross-node edge. The expression-position invocation
qualifier stays silent.
