---
id: kotlin-annotation-use-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Scopes (annotation class is a type ref); research Form D6 (annotation use)"
---

## Rule

An annotation use `@Audited fun f()` is a usage-site type reference (the annotation
class). The import-only extractor emits nothing for it, even with the annotation class
in-graph — a deliberate recall miss, never a false positive.

## Files

```kotlin path=src/audit/Audited.kt
package com.acme.audit
annotation class Audited
```

```kotlin path=src/c/Use.kt
package com.acme.app
@com.acme.audit.Audited
fun f() {}
```

## Expect

- silence      # an annotation use is a usage-site type ref → import-only emits nothing

## Why

The annotation class at a use site is a usage-site reference; binding it by simple name
would hit the precedence trap.
