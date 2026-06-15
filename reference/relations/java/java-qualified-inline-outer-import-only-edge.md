---
id: java-qualified-inline-outer-import-only-edge
language: java
category: nested
expectation: edge
cites: "JLS SE25 §6.5.5.2 (qualified type name); research D1'' (C20 in 06-14)"
---

## Rule

With `import com.foo.Outer;` and inline qualified uses `Outer.Inner` / `Outer.Mid.Deep`,
the ONLY emitted hint is the outer import (resolved to `com/foo/Outer.java`). The
`.Inner` / `.Mid.Deep` qualifiers at the use site add no separate hint (import-only),
and since the nested types live in the same file as `Outer`, the same node owns them —
nothing additional to miss. The outer import IS the edge.

## Files

```java path=src/main/java/com/foo/Outer.java
package com.foo;
public class Outer {
  public static class Inner {}
  public static class Mid {
    public static class Deep {}
  }
}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import com.foo.Outer;
class C {
  Outer.Inner i;
  Outer.Mid.Deep d;
}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:foo      # only the outer import com.foo.Outer is the edge (node foo); the inline qualifiers add no hint

## Why

The outer import captures the dependency on the enclosing file; the qualified inline
uses are usage sites that emit nothing, and the nested types share the same node.
