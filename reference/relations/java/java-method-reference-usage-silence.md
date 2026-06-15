---
id: java-method-reference-usage-silence
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §15.13 (method references); research F17 (C33 in 06-14)"
---

## Rule

Line 5 carries the generic witness `Supplier<com.acme.model.Foo>` — a fully-qualified
name in a type-argument TYPE position. It is a `scoped_type_identifier`, shadow-free per
§6.5.5.2, so the extractor emits a SYMBOL hint that resolves like an import → a real
cross-node edge to node `model`. The method reference `com.acme.util.Helpers::format` on
line 4 is in EXPRESSION position (a field-access / method-invocation chain, not a
`scoped_type_identifier`), so it stays silent — the zero-FP boundary. The JDK import
`java.util.function.Supplier` resolves to no in-repo file → silence. So line 5 edges and
line 4 stays silent.

## Files

```java path=src/main/java/com/acme/util/Helpers.java
package com.acme.util;
public class Helpers {
  public static void format() {}
}
```

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/app/C.java
package com.app;
import java.util.function.Supplier;
class C {
  Runnable r = com.acme.util.Helpers::format;
  Supplier<com.acme.model.Foo> s = com.acme.model.Foo::new;
}
```

## Expect

- src/main/java/com/app/C.java:5 -> node:model      # generic witness `Supplier<com.acme.model.Foo>` is shadow-free → real edge (node model)

## Why

A fully-qualified name in a type-argument TYPE position is shadow-free, so it resolves
like an import — a real cross-node edge. The expression-position `::` method reference
and the unresolved JDK import both stay silent.
