---
id: java-generic-argument-bound-edge
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §4.5.1, §4.4, §8.1.2; research F3/F4/F5 (C25 in 06-14)"
---

## Rule

Generic type arguments, type-parameter bounds and intersections (`A & B`), and wildcard
bounds (`? extends`/`? super`) are TYPE positions. A fully-qualified name written in any
of them is a `scoped_type_identifier` and is shadow-free per §6.5.5.2, so the extractor
emits a SYMBOL hint that resolves like an import → a real cross-node edge. The bound
`<T extends com.acme.model.Base & com.acme.flow.Iface>` is two refs (edges to node `model`
and node `flow`); the type argument `List<com.acme.model.Base>` edges to node `model`; the
wildcard bound `List<? extends com.acme.flow.Iface>` edges to node `flow` (the `?` itself
is not a ref). `java.util.List` resolves to no in-repo file → silence.

## Files

```java path=src/main/java/com/acme/model/Base.java
package com.acme.model;
public class Base {}
```

```java path=src/main/java/com/acme/flow/Iface.java
package com.acme.flow;
public interface Iface {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C<T extends com.acme.model.Base & com.acme.flow.Iface> {
  java.util.List<com.acme.model.Base> a;
  java.util.List<? extends com.acme.flow.Iface> b;
}
```

## Expect

- src/main/java/com/app/C.java:2 -> node:flow       # bound intersection `com.acme.flow.Iface` (node flow)
- src/main/java/com/app/C.java:2 -> node:model      # bound `com.acme.model.Base` (node model)
- src/main/java/com/app/C.java:3 -> node:model      # type argument `com.acme.model.Base` (node model)
- src/main/java/com/app/C.java:4 -> node:flow       # wildcard bound `com.acme.flow.Iface` (node flow)

## Why

Fully-qualified names in type arguments and bounds are shadow-free, so they resolve like
imports — real cross-node edges.
