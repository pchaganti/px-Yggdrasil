---
id: java-wildcard-one-owner-edge
language: java
category: import
expectation: edge
cites: "JLS SE25 §7.5.2 type-import-on-demand; research B2 (C4/C5 in 06-14)"
---

## Rule

A type-import-on-demand `import a.b.*;` emits the PACKAGE FQN `a.b` tagged
`isPackage=true` (JLS §7.5.2). The resolver lists the package directory's `.java`
files and collapses by owner set: exactly one distinct owner → attribute the edge to
that node (the deliberate v1 import = edge semantics — the import IS a real syntactic
dependency on the package); zero or 2+ owners → silence. Here the package directory
holds two files owned by the SAME node `audit` → one owner → one edge.

## Files

```java path=src/main/java/com/acme/audit/AuditLog.java
package com.acme.audit;
public class AuditLog {}
```

```java path=src/main/java/com/acme/audit/AuditWriter.java
package com.acme.audit;
public class AuditWriter {}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import com.acme.audit.*;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:audit      # wildcard over a one-owner package → attribute to node audit

## Why

The wildcard never asserts WHICH type is used; the one-owner collapse attributes the
package edge without guessing across a node split.
