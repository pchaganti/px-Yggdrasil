---
id: java-switch-pattern-types-edge
language: java
category: usage-site
expectation: edge
cites: "JEP 440 Record Patterns, JEP 441 Pattern Matching for switch (Java 21); research G5 (NEW vs 06-14)"
---

## Rule

Pattern types inside a `switch` are read where the grammar exposes them as a
`scoped_type_identifier` (a TYPE position) — and a fully-qualified name there is
shadow-free per §6.5.5.2, so the extractor emits a SYMBOL hint that resolves like an
import → a real cross-node edge. A simple type pattern `case com.a.Circle c ->` edges to
node `a`. A record (deconstruction) pattern reads its COMPONENT types as
`scoped_type_identifier`s: both the record declaration `record Rect(com.b.Point p, com.b.Size s)`
and the deconstruction pattern `case com.a.Rect(com.b.Point p, com.b.Size s) ->` edge to
node `b` for `com.b.Point`/`com.b.Size`. The OUTER deconstruction type `com.a.Rect` is
NOT exposed as a `scoped_type_identifier` in the record-pattern grammar node, so it stays
silent (a tolerated false-NEGATIVE). The binding identifiers (`c`, `p`, `s`) and any `_`
components are never type references.

## Files

```java path=src/main/java/com/a/Circle.java
package com.a;
public class Circle {}
```

```java path=src/main/java/com/a/Rect.java
package com.a;
public record Rect(com.b.Point p, com.b.Size s) {}
```

```java path=src/main/java/com/b/Point.java
package com.b;
public record Point(int x, int y) {}
```

```java path=src/main/java/com/b/Size.java
package com.b;
public record Size(int w, int h) {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  Object m(Object shape) {
    return switch (shape) {
      case com.a.Circle c -> 1;
      case com.a.Rect(com.b.Point p, com.b.Size s) -> 2;
      default -> 0;
    };
  }
}
```

## Expect

- src/main/java/com/a/Rect.java:2 -> node:b        # record components `com.b.Point` / `com.b.Size` (node b)
- src/main/java/com/app/C.java:5 -> node:a          # simple type pattern `com.a.Circle` (node a)
- src/main/java/com/app/C.java:6 -> node:b          # deconstruction component types `com.b.Point` / `com.b.Size` (node b)

## Why

A fully-qualified pattern type exposed as a `scoped_type_identifier` is shadow-free, so
it resolves like an import — a real cross-node edge. The outer deconstruction type
`com.a.Rect` is not exposed that way and stays silent; binding any pattern type by simple
name would reintroduce the §6.5.5 precedence trap and is FORBIDDEN. The bound names and
`_` are never type refs.
