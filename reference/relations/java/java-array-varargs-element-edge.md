---
id: java-array-varargs-element-edge
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §10.1, §8.4.1; research F13/F14 (C30 in 06-14)"
---

## Rule

An array type `Foo[]` and a varargs parameter `Bar...` carry their element type in a TYPE
position. A fully-qualified element type is a `scoped_type_identifier`, shadow-free per
§6.5.5.2, so the extractor emits a SYMBOL hint that resolves like an import → a real
cross-node edge. The field `com.acme.model.Foo[] a` and the varargs parameter
`com.acme.model.Bar... xs` each edge to node `model`.

## Files

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/acme/model/Bar.java
package com.acme.model;
public class Bar {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  com.acme.model.Foo[] a;
  void m(com.acme.model.Bar... xs) {}
}
```

## Expect

- src/main/java/com/app/C.java:3 -> node:model      # array element type `com.acme.model.Foo` (node model)
- src/main/java/com/app/C.java:4 -> node:model      # varargs element type `com.acme.model.Bar` (node model)

## Why

A fully-qualified array/varargs element type is shadow-free, so it resolves like an
import — a real cross-node edge.
