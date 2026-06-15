---
id: java-deep-nested-import-one-level-limit-silence
language: java
category: nested
expectation: silence
cites: "JLS SE25 §7.5.1; research D1' (C19 in 06-14)"
---

## Rule

The resolver drops EXACTLY one trailing segment for a nested import. A doubly-nested
`import com.acme.Outer.Mid.Deep;` tries `com/acme/Outer/Mid/Deep.java` (no) then
`com/acme/Outer/Mid.java` (no — `Mid` is also nested inside `Outer.java`, not its own
file); it does NOT drop further to `com/acme/Outer.java`. Result: a tolerated
false-NEGATIVE (silence), never a false positive. The one-level limit is deliberate.

## Files

```java path=src/main/java/com/acme/Outer.java
package com.acme;
public class Outer {
  public static class Mid {
    public interface Deep {}
  }
}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import com.acme.Outer.Mid.Deep;
class C {}
```

## Expect

- silence      # one-level fallback only reaches com/acme/Outer/Mid.java (absent); never drops to Outer.java → no edge

## Why

Dropping more than one segment would over-reach; the limit keeps resolution sound at
the cost of a tolerated missed edge for deeply-nested imports.
