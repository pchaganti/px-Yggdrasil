---
id: kotlin-nullable-array-vararg-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Scopes (nullable/array/vararg element types); research Form D14/D15/D16"
---

## Rule

A nullable `T?`, an `Array<T>`, and a `vararg` element type are usage-site type
references (`?` is nullability syntax; `Array`/`IntArray` are stdlib). The import-only
extractor emits nothing for them, even with the element type in-graph — a deliberate
recall miss, never a false positive.

## Files

```kotlin path=src/m/Order.kt
package com.acme.model
class Order
```

```kotlin path=src/c/Use.kt
package com.acme.app
class C {
  val o: com.acme.model.Order? = null
  val a: Array<com.acme.model.Order> = arrayOf()
  fun m(vararg xs: com.acme.model.Order) {}
}
```

## Expect

- silence      # nullable / array / vararg element types are usage sites → import-only emits nothing

## Why

The element type is a usage site in each form; `?` is syntax and `Array` is stdlib, so
the import-only design silences all three.
