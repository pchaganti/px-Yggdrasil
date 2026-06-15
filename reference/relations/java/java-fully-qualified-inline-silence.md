---
id: java-fully-qualified-inline-silence
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §6.5.5.2 (fully-qualified type name); research D2 (C22 in 06-14)"
---

## Rule

A type may be written fully qualified inline with NO import:
`com.b.Bar field; java.util.List<String> list = new java.util.ArrayList<>();`. The
outermost `scoped_type_identifier` in a TYPE position (here the field type
`com.b.Bar`) is a genuine cross-node dependency expressed entirely without an import.
Because the name is fully qualified it is shadow-free per §6.5.5.2 — there is no
simple-name precedence trap — so the extractor emits a SYMBOL hint that resolves
through the shared SymbolTable and binds the EXACT declaring file, exactly like an
import. `com.b.Bar` therefore edges to node `b`. The `java.util.List` / `java.util.ArrayList`
references resolve to no in-repo file → silence (no JDK in-graph).

## Files

```java path=src/main/java/com/b/Bar.java
package com.b;
public class Bar {}
```

```java path=src/main/java/com/a/X.java
package com.a;
class X {
  com.b.Bar field;
  java.util.List<String> list = new java.util.ArrayList<>();
}
```

## Expect

- src/main/java/com/a/X.java:3 -> node:b      # inline fully-qualified field type `com.b.Bar` is shadow-free → real edge (node b)

## Why

A fully-qualified inline TYPE reference is shadow-free per §6.5.5.2, so it resolves like
an import — a real cross-node edge, not a recall miss. Only the TYPE-position form edges;
an expression-position dotted access would stay silent.
