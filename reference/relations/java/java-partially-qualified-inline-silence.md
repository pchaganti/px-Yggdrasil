---
id: java-partially-qualified-inline-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §6.5.5.2; research D2' (C23 in 06-14)"
---

## Rule

A partially-qualified inline reference `Outer.Inner` (with `Outer` same-package, no
import) is NOT a fully-qualified `scoped_type_identifier` — its leading `Outer` is a bare
simple name, not a package prefix. Unlike a fully-qualified inline type reference (which
now edges because the FQN is shadow-free per §6.5.5.2), a partially-qualified name carries
no shadow-free hint → silence. Reading the partially-qualified chain as deeper packages,
or binding `Outer` by bare simple name, would reintroduce the §6.5.5 precedence trap and
is FORBIDDEN.

## Files

```java path=src/main/java/com/a/Outer.java
package com.a;
public class Outer {
  public static class Inner {}
}
```

```java path=src/main/java/com/a/X.java
package com.a;
class X {
  Outer.Inner i;
}
```

## Expect

- silence      # partially-qualified inline ref carries no import → no hint

## Why

The same-package bare `Outer` is unresolvable without the §6.5.5 trap; the missed edge
is tolerated.
