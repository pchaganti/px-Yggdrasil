---
id: java-new-anonymous-diamond-usage-silence
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §15.9, §15.9.5, §15.9.1; research F10/F11/F12 (C29 in 06-14)"
---

## Rule

The instantiated type of a `new` expression is a TYPE position. A fully-qualified `new`
type is a `scoped_type_identifier`, shadow-free per §6.5.5.2, so the extractor emits a
SYMBOL hint that resolves like an import → a real cross-node edge. `new com.acme.metrics.Timer()`
edges to node `metrics`; the anonymous class `new com.acme.base.Base() {}` edges to node
`base`; the diamond `new java.util.HashMap<String, com.acme.model.Foo>()` carries the
type-argument `com.acme.model.Foo` (node `model`), while its `java.util.HashMap` raw type
resolves to no in-repo file → silence.

## Files

```java path=src/main/java/com/acme/metrics/Timer.java
package com.acme.metrics;
public class Timer {}
```

```java path=src/main/java/com/acme/base/Base.java
package com.acme.base;
public class Base {}
```

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m() {
    var a = new com.acme.metrics.Timer();
    var b = new com.acme.base.Base() {};
    var c = new java.util.HashMap<String, com.acme.model.Foo>();
  }
}
```

## Expect

- src/main/java/com/app/C.java:4 -> node:metrics      # `new com.acme.metrics.Timer()` (node metrics)
- src/main/java/com/app/C.java:5 -> node:base         # anonymous-class supertype `com.acme.base.Base` (node base)
- src/main/java/com/app/C.java:6 -> node:model        # diamond type-argument `com.acme.model.Foo` (node model)

## Why

A fully-qualified `new` type (and a fully-qualified diamond type argument) is shadow-free,
so it resolves like an import — a real cross-node edge.
