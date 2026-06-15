---
id: java-bare-autoimport-usage-silence
language: java
category: builtin
expectation: silence
cites: "JLS SE25 §7.3 (automatic java.lang import); research C1 (C10 in 06-14)"
---

## Rule

Every compilation unit implicitly imports every public type of `java.lang`
(JLS §7.3). A bare `String s;` / `Object o;` / `extends Exception` / `throws Exception`
has NO import line; the import-only extractor walks only `import_declaration`, so it
emits no hint at all. Double silence: no usage-site analysis, and no import to misread.

## Files

```java path=src/main/java/com/app/C.java
package com.app;
class C extends Exception {
  String s;
  Object o;
  void m() throws Exception { @Override int x = 0; }
}
```

## Expect

- silence      # no import_declaration → no hint; bare auto-imported names are never read

## Why

Auto-imported java.lang names appear with no import; the extractor never sees them, so
there is nothing to bind.
