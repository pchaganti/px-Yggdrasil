---
id: java-multi-catch-usage-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §14.20, §6.5.5; research F16 (C32 in 06-14)"
---

## Rule

A multi-catch `catch (A | B e)` references TWO exception types at a usage site, both
carrying no import. The import-only extractor emits no hint for either.

## Files

```java path=src/main/java/com/acme/err/E1.java
package com.acme.err;
public class E1 extends Exception {}
```

```java path=src/main/java/com/acme/err/E2.java
package com.acme.err;
public class E2 extends Exception {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m() {
    try {} catch (com.acme.err.E1 | com.acme.err.E2 e) {}
  }
}
```

## Expect

- silence      # multi-catch types are usage sites with no import → no hint

## Why

Each caught type is a usage site; the import-only model silences both.
