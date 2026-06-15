---
id: kotlin-annotation-use-site-target-not-ref
language: kotlin
category: usage-site
expectation: edge
cites: "What's new in Kotlin 2.2.0 — @all meta-target; What's new in Kotlin 2.4.0 — @all + use-site-target defaulting Stable; research Form E8"
---

## Rule

An annotation use-site target prefix (`@all:`, `@field:`, `@get:`, `@set:`, `@param:`,
`@receiver:`, `@property:`, `@setparam:`) is a target SELECTOR keyword, NEVER a type
reference. The annotation CLASS after the `:`, when written as an inline fully-qualified
name (`com.acme.audit.Email`), sits in a TYPE position: the FQN is shadow-free and
resolves through the shared SymbolTable exactly like an import, so it is a real edge.
The use-site-target keyword `field`/`all` is STILL not a reference and produces NO edge —
only the annotation class does.

## Files

```kotlin path=src/audit/Email.kt
package com.acme.audit
annotation class Email
```

```kotlin path=src/c/Use.kt
package com.acme.app
class C {
  @field:com.acme.audit.Email
  val email: String = ""
}
```

## Expect

- src/c/Use.kt:3 -> node:audit      # the annotation CLASS as an inline FQN (`com.acme.audit.Email`) is a type-position ref → real edge

## Why

The annotation class written as an inline fully-qualified name is a TYPE-position
reference; the FQN is shadow-free, so it resolves like an import and is a real edge.
Reading the use-site-target keyword (`all`/`field`/`get`/…) as a type reference, by
contrast, would emit a spurious edge for a Kotlin keyword — so the keyword is NOT a
reference and produces no edge; only the annotation class does.
