---
id: java-generic-argument-bound-usage-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §4.5.1, §4.4, §8.1.2; research F3/F4/F5 (C25 in 06-14)"
---

## Rule

Generic type arguments, type-parameter bounds and intersections (`A & B`), and wildcard
bounds (`? extends`/`? super`) are usage sites that reference types but carry no import.
The import-only extractor emits no hint. `A & B` is two refs; the `?` wildcard is not a
ref. All silent.

## Files

```java path=src/main/java/com/acme/model/Base.java
package com.acme.model;
public class Base {}
```

```java path=src/main/java/com/acme/flow/Iface.java
package com.acme.flow;
public interface Iface {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C<T extends com.acme.model.Base & com.acme.flow.Iface> {
  java.util.List<com.acme.model.Base> a;
  java.util.List<? extends com.acme.flow.Iface> b;
}
```

## Expect

- silence      # generic args / bounds / wildcard bounds are usage sites with no import → no hint

## Why

Type arguments and bounds are usage sites; the import-only model silences them.
