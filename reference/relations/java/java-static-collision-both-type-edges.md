---
id: java-static-collision-both-type-edges
language: java
category: import
expectation: edge
cites: "JLS SE25 §7.5.3, §7.5.4; research B3/B4 (C8 in 06-14)"
---

## Rule

`import static com.util.Maths.max;` and `import static com.util.Limits.*;` — each
import IS a real syntactic dependency on its declaring TYPE; both resolve
independently to their type files. Which `max` actually binds at a call site is
irrelevant under the import-only model. Both edges fire.

## Files

```java path=src/main/java/com/util/maths/Maths.java
package com.util.maths;
public class Maths {
  public static int max(int a, int b) { return a > b ? a : b; }
}
```

```java path=src/main/java/com/util/limits/Limits.java
package com.util.limits;
public class Limits {
  public static int max() { return 100; }
}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import static com.util.maths.Maths.max;
import static com.util.limits.Limits.*;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:maths       # single-static-import → TYPE Maths (node maths)
- src/main/java/com/app/Use.java:3 -> node:limits      # static-on-demand → TYPE Limits (node limits)

## Why

Each static import resolves to its own declaring type independently; a static member
collision at the call site does not affect which TYPE files are the dependencies.
