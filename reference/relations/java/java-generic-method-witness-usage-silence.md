---
id: java-generic-method-witness-usage-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §15.12, §8.4.4; research F18 (C34 in 06-14)"
---

## Rule

An explicit generic method type witness `Collections.<Foo>emptyList()` references the
witness type at a usage site, carrying no import. The import-only extractor emits no
hint.

## Files

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m() {
    var l = java.util.Collections.<com.acme.model.Foo>emptyList();
  }
}
```

## Expect

- silence      # the explicit type witness is a usage site with no import → no hint

## Why

A method type witness is a usage site; the import-only model silences it.
