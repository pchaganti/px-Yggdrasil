---
id: kotlin-pair-to-tuple-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Scopes (tuple element types); research Form D13 (Pair / to tuple)"
---

## Rule

`Pair`/`to` tuple element types (`Pair<Order, Receipt>`) are usage-site references, and
`Pair`/`to` are stdlib. The import-only extractor emits nothing for them, even with the
element types in-graph — a deliberate recall miss, never a false positive.

## Files

```kotlin path=src/m/Order.kt
package com.acme.model
class Order
```

```kotlin path=src/m/Receipt.kt
package com.acme.model
class Receipt
```

```kotlin path=src/c/Use.kt
package com.acme.app
val t: Pair<com.acme.model.Order, com.acme.model.Receipt>? = null
```

## Expect

- silence      # tuple element types are usage sites and `Pair` is stdlib → import-only emits nothing

## Why

The element types are usage sites; `Pair` is stdlib; the import-only design silences
both.
