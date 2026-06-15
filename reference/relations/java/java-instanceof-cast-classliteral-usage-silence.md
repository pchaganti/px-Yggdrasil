---
id: java-instanceof-cast-classliteral-usage-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §15.20.2, §15.16, §15.8.2; research F7/F8/F9 (C27 in 06-14)"
---

## Rule

`instanceof` (including the pattern form `instanceof X y`), casts `(X) o`, and
reference-type class literals `X.class` are usage sites referencing types but carrying
no import. The import-only extractor emits no hint. The pattern binding `f` is NOT a
type reference.

## Files

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/acme/model/Bar.java
package com.acme.model;
public class Bar {}
```

```java path=src/main/java/com/acme/model/Baz.java
package com.acme.model;
public class Baz {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  void m(Object o) {
    if (o instanceof com.acme.model.Foo f) {}
    var x = (com.acme.model.Bar) o;
    var k = com.acme.model.Baz.class;
  }
}
```

## Expect

- silence      # instanceof / cast / class-literal are usage sites with no import → no hint

## Why

These are usage sites; the import-only model silences them, and the pattern binding
name is never a type.
