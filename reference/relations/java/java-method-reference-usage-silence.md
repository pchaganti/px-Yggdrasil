---
id: java-method-reference-usage-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §15.13 (method references); research F17 (C33 in 06-14)"
---

## Rule

A method reference `Type::m` / `Type::new` references its qualifier type at a usage
site, carrying no import. The import-only extractor emits no hint for the `::` refs.
The only import here is the JDK `java.util.function.Supplier`, which resolves to no
in-repo file → silence. So the whole unit is silent.

## Files

```java path=src/main/java/com/acme/util/Helpers.java
package com.acme.util;
public class Helpers {
  public static void format() {}
}
```

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/app/C.java
package com.app;
import java.util.function.Supplier;
class C {
  Runnable r = com.acme.util.Helpers::format;
  Supplier<com.acme.model.Foo> s = com.acme.model.Foo::new;
}
```

## Expect

- silence      # the only import (JDK Supplier) does not resolve; the `::` qualifier refs emit no hint

## Why

Method-reference qualifiers are usage sites; the JDK import fails to find. No edge.
