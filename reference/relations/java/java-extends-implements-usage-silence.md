---
id: java-extends-implements-usage-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §8.1.4, §8.1.5, §9.1.3; research F1/F2 (C24 in 06-14)"
---

## Rule

`extends` superclass and `implements` interface lists with fully-qualified names are
usage sites — they reference types but carry no import. The import-only extractor emits
no hint. `Runnable` is auto-imported java.lang (silence anyway). Binding any by simple
name would reintroduce the §6.5.5 precedence trap and is FORBIDDEN.

## Files

```java path=src/main/java/com/acme/base/Base.java
package com.acme.base;
public class Base {}
```

```java path=src/main/java/com/acme/flow/Flowable.java
package com.acme.flow;
public interface Flowable {}
```

```java path=src/main/java/com/app/C.java
package com.app;
class C extends com.acme.base.Base implements com.acme.flow.Flowable, Runnable {}
```

## Expect

- silence      # extends/implements are usage sites with no import → no hint, even though Base/Flowable are in-graph

## Why

A supertype reference is a usage site; the import-only model silences it as a tolerated
recall miss.
