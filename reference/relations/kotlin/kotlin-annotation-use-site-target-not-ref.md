---
id: kotlin-annotation-use-site-target-not-ref
language: kotlin
category: usage-site
expectation: silence
cites: "What's new in Kotlin 2.2.0 — @all meta-target; What's new in Kotlin 2.4.0 — @all + use-site-target defaulting Stable; research Form E8"
---

## Rule

An annotation use-site target prefix (`@all:`, `@field:`, `@get:`, `@set:`, `@param:`,
`@receiver:`, `@property:`, `@setparam:`) is a target SELECTOR keyword, NEVER a type
reference. Only the annotation CLASS after the `:` is a (usage-site, silenced)
reference. The import-only extractor emits nothing for an annotated property: neither
the target keyword `field`/`all` nor the annotation class produces an edge.

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

- silence      # the use-site-target keyword (`field`) is never a type ref, and the annotation use is a usage site → import-only emits nothing

## Why

Reading a use-site-target keyword (`all`/`field`/`get`/…) as a type reference would
emit a spurious edge for a Kotlin keyword; only the annotation class is a reference, and
it is itself a silenced usage site.
