---
id: java-single-static-import-drop-member-edge
language: java
category: import
expectation: edge
cites: "JLS SE25 §7.5.3 single-static-import; research B3 (C6 in 06-14)"
---

## Rule

A single-static-import `import static a.b.C.M;` imports the static member `M` of
type `C` (JLS §7.5.3). The dependency unit is the DECLARING TYPE `C`, not the member.
The extractor detects the `static` token and drops the trailing member segment
(`com.acme.util.Helpers.format` → `com.acme.util.Helpers`), emitting the TYPE FQN
that `resolveJavaFqn` maps to `com/acme/util/Helpers.java`. The drop is the guard:
without it the analyzer would seek a `helpers/format.java` (a miss) or mis-bind a
member-named sibling.

## Files

```java path=src/main/java/com/acme/util/Helpers.java
package com.acme.util;
public class Helpers {
  public static String format(Object o) { return String.valueOf(o); }
}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import static com.acme.util.Helpers.format;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:util      # member `format` dropped → TYPE com.acme.util.Helpers (node util)

## Why

The declaring type is the real dependency; dropping the member keeps the edge on the
type file and never on a phantom member path.
