---
id: java-multi-import-one-edge-each
language: java
category: import
expectation: edge
cites: "JLS SE25 §7.5.1; research B1 (C3 in 06-14, multi-import)"
---

## Rule

A compilation unit with several single-type-imports produces one exact-FQN edge per
import — each resolved independently by `resolveJavaFqn` to its own `.java` file. The
imports are not aggregated; each is its own per-type dependency.

## Files

```java path=src/main/java/com/acme/a/Alpha.java
package com.acme.a;
public class Alpha {}
```

```java path=src/main/java/com/acme/b/Beta.java
package com.acme.b;
public class Beta {}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import com.acme.a.Alpha;
import com.acme.b.Beta;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:a      # import com.acme.a.Alpha → node a
- src/main/java/com/app/Use.java:3 -> node:b      # import com.acme.b.Beta → node b

## Why

Each import is its own syntactic dependency; one edge each, on its own merit.
