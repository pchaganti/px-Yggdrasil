---
id: java-two-wildcards-each-own-merit-edge
language: java
category: import
expectation: edge
cites: "JLS SE25 §7.5.2, §6.5.5.1 (on-demand ambiguity); research D3 (C17 in 06-14)"
---

## Rule

Two type-import-on-demand declarations offering the same simple name (`Foo`) make the
bare `Foo` use a COMPILE ERROR in Java (ambiguous), but the analyzer never binds the
bare simple name. It emits two independent PACKAGE hints (`com.x`, `com.y`), each
owner-set-collapsed on its own. Here each package maps to exactly one owner, so each
wildcard attributes ITS package edge (import = edge); the ambiguous `Foo` use is
silent (no use-site hint, no fabricated edge).

## Files

```java path=src/main/java/com/x/Foo.java
package com.x;
public class Foo {}
```

```java path=src/main/java/com/y/Foo.java
package com.y;
public class Foo {}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import com.x.*;
import com.y.*;
class C { Foo f; }
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:x      # wildcard com.x → one owner x
- src/main/java/com/app/Use.java:3 -> node:y      # wildcard com.y → one owner y

## Why

Each wildcard is its own package dependency resolved independently; the ambiguous bare
name is never the binding axis, so no arbitrary use-site edge is fabricated.
