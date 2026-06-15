---
id: java-array-varargs-element-usage-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §10.1, §8.4.1; research F13/F14 (C30 in 06-14)"
---

## Rule

An array type `Foo[]` and a varargs parameter `Bar...` reference their element types at
usage sites, but carry no import. The import-only extractor emits no hint.

## Files

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/acme/model/Bar.java
package com.acme.model;
public class Bar {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  com.acme.model.Foo[] a;
  void m(com.acme.model.Bar... xs) {}
}
```

## Expect

- silence      # array element / varargs element are usage sites with no import → no hint

## Why

The element type of an array or varargs is a usage site; the import-only model silences it.
