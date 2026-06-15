---
id: java-nested-import-enclosing-file-edge
language: java
category: nested
expectation: edge
cites: "JLS SE25 §7.5.1, §8.5 (member type import); research D1 (C18 in 06-14)"
---

## Rule

A nested type is a member of its enclosing type, importable directly
`import a.Outer.Inner;` (single-type-import of a member type, JLS §7.5.1). Java
compiles a nested type into its ENCLOSING file (`Outer.java`), not a subdirectory.
The resolver tries `com/foo/Outer/Inner.java` (won't exist) then the one-level
parent fallback `com/foo/Outer.java` (the enclosing type's file) → attributes the
edge to Outer's node.

## Files

```java path=src/main/java/com/foo/Outer.java
package com.foo;
public class Outer {
  public static class Inner {}
}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import com.foo.Outer.Inner;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:foo      # nested import falls back to com/foo/Outer.java (node foo)

## Why

The one-level enclosing-file fallback recovers the real nested-type meaning without
reading the nested member chain as deeper packages.
