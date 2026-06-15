---
id: java-throws-clause-usage-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §8.4.6, §11.1.1; research F15 (C31 in 06-14)"
---

## Rule

A `throws` clause type is a usage-site reference carrying no import. The import-only
extractor emits no hint.

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

- silence      # the throws-clause type is a usage site with no import → no hint

## Why

A thrown type is a usage site; the import-only model silences it.
