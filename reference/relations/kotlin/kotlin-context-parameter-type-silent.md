---
id: kotlin-context-parameter-type-silent
language: kotlin
category: usage-site
expectation: silence
cites: "What's new in Kotlin 2.4.0 — Stable context parameters; What's new in Kotlin 2.2.0 — context parameters preview; research Form E5"
---

## Rule

A context parameter `context(repo: T)` (Stable in Kotlin 2.4) declares a new
declaration-HEADER position carrying a type reference `T`. The parameter TYPE is an
ordinary usage-site type reference resolved by the precedence walk — NOT a new way to
name a type, and the parameter NAME is not a reference. The import-only extractor
performs no usage-site refinement, so the context-parameter type emits nothing even
when the referenced type is in-graph — a deliberate recall miss, never a false
positive. The only edge would be an explicit `import` of the type.

## Files

```kotlin path=src/data/OrderRepo.kt
package com.acme.data
class OrderRepo
```

```kotlin path=src/c/Use.kt
package com.acme.app
context(repo: com.acme.data.OrderRepo)
fun save() {}
```

## Expect

- silence      # the context-parameter type is a usage site on a new header position → import-only emits nothing

## Why

The context-parameter type sits on the declaration header (like a primary-constructor
parameter type) — a position a body-only walker would skip. Documenting it pins the new
2.4 header position so a future usage-site implementer does not bind it by simple name
(which would reintroduce the precedence trap).
