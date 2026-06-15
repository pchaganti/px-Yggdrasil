---
id: java-switch-pattern-types-silent
language: java
category: usage-site
expectation: silence
cites: "JEP 440 Record Patterns, JEP 441 Pattern Matching for switch (Java 21); research G5 (NEW vs 06-14)"
---

## Rule

A type pattern `case X x ->` and a record (deconstruction) pattern
`case R(com.b.Point p, com.b.Size s) ->` reference the types `X`, `R`, `Point`, `Size` —
but at a usage site (inside a `switch_expression`), with no import. The import-only
extractor emits no hint. The binding identifiers (`x`, `p`, `s`) and any `_` components
are NOT references; a future usage-site / record-pattern walker must skip the binding
names and `_` and read only the pattern TYPES.

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

- silence      # switch type/record patterns are usage sites with no import → no hint, even though Circle/Rect/Point/Size are in-graph

## Why

A `switch` pattern is a usage site; binding it by simple name would reintroduce the
§6.5.5 precedence trap and is FORBIDDEN. The bound names and `_` are never type refs.
