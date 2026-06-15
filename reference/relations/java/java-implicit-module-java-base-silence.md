---
id: java-implicit-module-java-base-silence
language: java
category: builtin
expectation: silence
cites: "JLS SE25 §7.3 (compact compilation units); JEP 512 (Java 25); research C2 (NEW vs 06-14)"
---

## Rule

A compact compilation unit (an implicitly-declared class with an instance `main`, JEP
512) implicitly imports, on demand, all public top-level types of every package exported
by `java.base` — "as if `import module java.base;` appeared at the beginning." So
`List` / `Map` / `Path` are usable with no import. Like the implicit `java.lang.*`,
these are JDK module-path metadata with no in-repo `.java`; with no import and no
usage-site analysis, the extractor emits nothing.

## Files

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m() {
    List<String> xs = null;
    Map<String, String> m = null;
  }
}
```

## Expect

- silence      # implicitly-java.base-imported names carry no import → no hint

## Why

The implicit `java.base` set is unenumerable source-only, exactly like `java.lang.*`;
no import line means nothing to bind.
