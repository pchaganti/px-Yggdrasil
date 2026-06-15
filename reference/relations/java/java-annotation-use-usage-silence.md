---
id: java-annotation-use-usage-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §9.6, §9.7 (annotation use); research F6 (C26 in 06-14)"
---

## Rule

A user-package annotation use `@com.acme.audit.Audit` is a usage site referencing the
annotation type, but it carries no import. The import-only extractor emits no hint.

## Files

```java path=src/main/java/com/acme/audit/Audit.java
package com.acme.audit;
public @interface Audit {}
```

```java path=src/main/java/com/app/C.java
package com.app;
@com.acme.audit.Audit
class C {}
```

## Expect

- silence      # annotation use is a usage site with no import → no hint, even though Audit is in-graph

## Why

Annotation USE is a usage site; the import-only model silences it.
