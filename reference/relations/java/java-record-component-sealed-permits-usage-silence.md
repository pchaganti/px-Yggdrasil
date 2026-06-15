---
id: java-record-component-sealed-permits-usage-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §8.10 (records), §8.1.1.2 (sealed permits); research F19/F20 (C35 in 06-14)"
---

## Rule

A `record R(com.acme.model.Foo f) {}` component type and a
`sealed interface S permits com.acme.model.Sub {}` permit type are usage-site
references carrying no import. The import-only extractor emits no hint.

## Files

```java path=src/main/java/com/acme/model/Foo.java
package com.acme.model;
public class Foo {}
```

```java path=src/main/java/com/acme/model/Sub.java
package com.acme.model;
public final class Sub {}
```

```java path=src/main/java/com/app/Decls.java
package com.app;
record R(com.acme.model.Foo f) {}
sealed interface S permits com.acme.model.Sub {}
```

## Expect

- silence      # record component types and sealed permit types are usage sites with no import → no hint

## Why

Record components and permit lists are usage sites; the import-only model silences them.
