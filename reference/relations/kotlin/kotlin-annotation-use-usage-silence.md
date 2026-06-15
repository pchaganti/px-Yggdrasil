---
id: kotlin-annotation-use-usage-silence
language: kotlin
category: usage-site
expectation: edge
cites: "Kotlin spec — Scopes (annotation class is a type ref); research Form D6 (annotation use)"
---

## Rule

An annotation use `@com.acme.audit.Audited fun f()` names the annotation class in a
TYPE position. When written as an inline fully-qualified name the FQN is shadow-free
and resolves through the shared SymbolTable exactly like an import, so it is a real
edge to the annotation class's node.

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

- src/c/Use.kt:2 -> node:audit      # the annotation class as an inline FQN is a type-position ref → real edge

## Why

The annotation class at an annotation use is a TYPE-position reference; written as an
inline fully-qualified name it is shadow-free and resolves like an import, so it is a
real edge — no simple-name precedence guess is involved.
