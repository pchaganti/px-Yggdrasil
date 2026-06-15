---
id: java-fully-qualified-inline-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §6.5.5.2 (fully-qualified type name); research D2 (C22 in 06-14)"
---

## Rule

A type may be written fully qualified inline with NO import:
`com.b.Bar field; java.util.List<String> list = new java.util.ArrayList<>();`. No
import → no hint → nothing to mis-bind. But `com.b.Bar field;` is a genuine cross-node
dependency expressed entirely without an import — the import-only extractor never sees
it: the single biggest coverage gap (a tolerated false-NEGATIVE). It is also the
SAFEST future usage-site extension (a fully-qualified name is shadow-free per §6.5.5.2),
but it is new extractor code deferred to owner review, NOT auto-implemented.

## Files

```java path=src/main/java/com/b/Bar.java
package com.b;
public class Bar {}
```

```java path=src/main/java/com/a/X.java
package com.a;
class X {
  com.b.Bar field;
  java.util.List<String> list = new java.util.ArrayList<>();
}
```

## Expect

- silence      # inline FQN refs carry no import → no hint, even though com.b.Bar is in-graph (node b)

## Why

The import-only model trades this recall miss for zero false positives; the inline-FQN
form is the safest future edge but is not shipped.
