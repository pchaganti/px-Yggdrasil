---
id: java-instanceof-cast-classliteral-edge
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §15.20.2, §15.16, §15.8.2; research F7/F8/F9 (C27 in 06-14)"
---

## Rule

`instanceof` (including the pattern form `instanceof X y`), casts `(X) o`, and
reference-type class literals `X.class` all hold their type in a TYPE position. A
fully-qualified name in any of them is a `scoped_type_identifier`, shadow-free per
§6.5.5.2, so the extractor emits a SYMBOL hint that resolves like an import → a real
cross-node edge. `instanceof com.acme.model.Foo`, `(com.acme.model.Bar)`, and
`com.acme.model.Baz.class` each edge to node `model`. The pattern binding `f` is NOT a
type reference and never edges.

## Files

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/acme/model/Bar.java
package com.acme.model;
public class Bar {}
```

```java path=src/main/java/com/acme/model/Baz.java
package com.acme.model;
public class Baz {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m(Object o) {
    if (o instanceof com.acme.model.Foo f) {}
    var x = (com.acme.model.Bar) o;
    var k = com.acme.model.Baz.class;
  }
}
```

## Expect

- src/main/java/com/app/C.java:4 -> node:model      # `instanceof com.acme.model.Foo` (node model)
- src/main/java/com/app/C.java:5 -> node:model      # cast `(com.acme.model.Bar)` (node model)
- src/main/java/com/app/C.java:6 -> node:model      # class literal `com.acme.model.Baz.class` (node model)

## Why

Fully-qualified names in instanceof / cast / class-literal positions are shadow-free, so
they resolve like imports — real cross-node edges. The pattern binding name is never a type.
