---
id: kotlin-generic-argument-where-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Overload resolution / Scopes; research Form D2/D3 (generic argument + where)"
---

## Rule

A generic type argument (`List<Order>`) and a `where` constraint
(`where T : Comparable<T>`) are usage-site type references. The import-only extractor
emits nothing for them, even with the referenced types in-graph — a deliberate recall
miss, never a false positive.

## Files

```kotlin path=src/m/Order.kt
package com.acme.model
class Order
```

```kotlin path=src/m/Comparable.kt
package com.acme.model
interface Comparable<T>
```

```kotlin path=src/c/Use.kt
package com.acme.app
val xs: List<com.acme.model.Order> = emptyList()
fun <T> f(t: T) where T : com.acme.model.Comparable<T> {}
```

## Expect

- silence      # generic argument + where-constraint types are usage sites → import-only emits nothing

## Why

Generic and constraint positions are usage sites; binding them by simple name would
hit the precedence and stdlib-collision traps.
