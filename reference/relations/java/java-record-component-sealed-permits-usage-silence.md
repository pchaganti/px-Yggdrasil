---
id: java-record-component-sealed-permits-usage-silence
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §8.10 (records), §8.1.1.2 (sealed permits); research F19/F20 (C35 in 06-14)"
---

## Rule

A record component type `record R(com.acme.model.Foo f) {}` and a sealed permit type
`sealed interface S permits com.acme.model.Sub {}` are both TYPE positions. A
fully-qualified name in either is a `scoped_type_identifier`, shadow-free per §6.5.5.2,
so the extractor emits a SYMBOL hint that resolves like an import → a real cross-node
edge. The record component `com.acme.model.Foo` and the permit type `com.acme.model.Sub`
each edge to node `model`.

## Files

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/acme/model/Sub.java
package com.acme.model;
public final class Sub {}
```

```java path=src/main/java/com/app/Decls.java
package com.app;
record R(com.acme.model.Foo f) {}
sealed interface S permits com.acme.model.Sub {}
```

## Expect

- src/main/java/com/app/Decls.java:2 -> node:model      # record component `com.acme.model.Foo` (node model)
- src/main/java/com/app/Decls.java:3 -> node:model      # sealed permit type `com.acme.model.Sub` (node model)

## Why

Fully-qualified record-component and permit types are shadow-free, so they resolve like
imports — real cross-node edges.
