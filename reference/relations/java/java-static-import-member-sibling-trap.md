---
id: java-static-import-member-sibling-trap
language: java
category: trap
expectation: edge
cites: "JLS SE25 §7.5.3 (the declaring type is the unit); research B3 member/sibling trap (C6 in 06-14)"
---

## Rule

`import static com.acme.util.Helpers.format;` — if the `.format` member were NOT
dropped, the hint `com.acme.util.Helpers.format` would resolve via the one-level
nested fallback toward a `Helpers/format.java` decoy (a different node) instead of
the declaring type. Dropping the trailing member guarantees the TYPE
`com.acme.util.Helpers` is the only candidate → `com/acme/util/Helpers.java`
(node util), never the member-named decoy.

## Files

```java path=src/main/java/com/acme/util/Helpers.java
package com.acme.util;
public class Helpers {
  public static String format(Object o) { return String.valueOf(o); }
}
```

```java path=src/main/java/com/acme/util/Helpers/format.java
package com.acme.util.Helpers;
public class format {}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import static com.acme.util.Helpers.format;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:util      # the dropped-member edge is the TYPE Helpers (node util), never the member-named decoy (node Helpers)

## Why

The member-segment drop pins the edge on the declaring type and cannot be lured to a
file whose name coincides with the imported member.
