---
id: java-vendored-jdk-mapped-edge
language: java
category: builtin
expectation: edge
cites: "JLS SE25 §7.5.1; research vendored-JDK (C40 in 06-14)"
---

## Rule

The ONLY way a `java.*` import fires: the adopter literally VENDORED
`java/lang/String.java` into the repo at a path the package = directory convention
finds, AND a node maps it. At that point it is a real, in-repo, mapped dependency —
flagging the missing relation is CORRECT, not a false positive. Silence is fail-to-find,
not a `java.*` denylist; a present-and-mapped file is a genuine edge.

## Files

```java path=src/main/java/java/lang/String.java
package java.lang;
public final class String {}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import java.lang.String;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:lang      # vendored java/lang/String.java is mapped → a real edge (node lang)

## Why

The anti-FP property is fail-to-find, not a denylist; a vendored-and-mapped JDK file is
a genuine dependency.
