---
id: java-extends-implements-edge
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §8.1.4, §8.1.5, §9.1.3; research F1/F2 (C24 in 06-14)"
---

## Rule

`extends` superclass and `implements` interface lists written with fully-qualified
names are `scoped_type_identifier`s in TYPE positions. Because each name is fully
qualified it is shadow-free per §6.5.5.2, so the extractor emits a SYMBOL hint that
resolves like an import → real cross-node edges. `extends com.acme.base.Base` edges to
node `base` and `implements com.acme.flow.Flowable` edges to node `flow`. `Runnable` is
a bare simple name (auto-imported java.lang), not a fully-qualified `scoped_type_identifier`,
so it stays silent — binding it by simple name would reintroduce the §6.5.5 precedence trap.

## Files

```java path=src/main/java/com/acme/base/Base.java
package com.acme.base;
public class Base {}
```

```java path=src/main/java/com/acme/flow/Flowable.java
package com.acme.flow;
public interface Flowable {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C extends com.acme.base.Base implements com.acme.flow.Flowable, Runnable {}
```

## Expect

- src/main/java/com/app/C.java:2 -> node:base      # `extends com.acme.base.Base` fully-qualified → real edge (node base)
- src/main/java/com/app/C.java:2 -> node:flow      # `implements com.acme.flow.Flowable` fully-qualified → real edge (node flow)

## Why

A fully-qualified supertype reference is shadow-free, so it resolves like an import — a
real cross-node edge. The bare `Runnable` is not fully qualified and stays silent.
