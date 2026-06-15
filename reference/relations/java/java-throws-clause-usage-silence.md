---
id: java-throws-clause-usage-silence
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §8.4.6, §11.1.1; research F15 (C31 in 06-14)"
---

## Rule

A `throws` clause holds its thrown type in a TYPE position. A fully-qualified thrown type
is a `scoped_type_identifier`, shadow-free per §6.5.5.2, so the extractor emits a SYMBOL
hint that resolves like an import → a real cross-node edge. `throws com.acme.err.Boom`
edges to node `err`.

## Files

```java path=src/main/java/com/acme/err/Boom.java
package com.acme.err;
public class Boom extends Exception {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m() throws com.acme.err.Boom {}
}
```

## Expect

- src/main/java/com/app/C.java:3 -> node:err      # `throws com.acme.err.Boom` fully-qualified → real edge (node err)

## Why

A fully-qualified thrown type is shadow-free, so it resolves like an import — a real
cross-node edge.
