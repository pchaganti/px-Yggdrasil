---
id: java-new-anonymous-diamond-usage-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §15.9, §15.9.5, §15.9.1; research F10/F11/F12 (C29 in 06-14)"
---

## Rule

`new com.acme.metrics.Timer()`, an anonymous class `new com.acme.base.Base() {}`, and a
diamond `new java.util.HashMap<String, com.acme.model.Foo>()` are usage sites
referencing types but carrying no import. The import-only extractor emits no hint. The
anonymous class's named supertype and the diamond's raw type are usage-site refs only.

## Files

```java path=src/main/java/com/acme/metrics/Timer.java
package com.acme.metrics;
public class Timer {}
```

```java path=src/main/java/com/acme/base/Base.java
package com.acme.base;
public class Base {}
```

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m() {
    var a = new com.acme.metrics.Timer();
    var b = new com.acme.base.Base() {};
    var c = new java.util.HashMap<String, com.acme.model.Foo>();
  }
}
```

## Expect

- silence      # new / anonymous / diamond are usage sites with no import → no hint

## Why

Object-creation expressions are usage sites; the import-only model silences them.
