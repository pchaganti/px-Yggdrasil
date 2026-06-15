---
id: java-static-on-demand-type-not-package-edge
language: java
category: import
expectation: edge
cites: "JLS SE25 §7.5.4 static-import-on-demand; research B4 (C7 in 06-14)"
---

## Rule

A static-import-on-demand `import static a.b.C.*;` imports all static members of the
TYPE `C` (JLS §7.5.4). The `*` is present, but the scoped identifier `a.b.C` is a
TYPE, not a package. The extractor sees BOTH `static` AND `asterisk` and emits with
`isPackage = !isStatic` → false, so `com.acme.util.Constants` routes through
`resolveJavaFqn` as a TYPE → `com/acme/util/Constants.java`, NEVER scanned as a
package directory `com/acme/util/Constants/`. This is the one case where an asterisk
does NOT mean "package".

## Files

```java path=src/main/java/com/acme/util/Constants.java
package com.acme.util;
public class Constants {
  public static final int MAX = 10;
}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import static com.acme.util.Constants.*;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:util      # asterisk + static → TYPE com.acme.util.Constants (node util), not a package dir

## Why

A single-bit misclassification (`isPackage` true here) would miss the edge or scan a
non-existent directory; the `!isStatic` rule keeps a static-on-demand on the type axis.
