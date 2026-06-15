---
id: kotlin-class-literal-callable-ref-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin docs — Reflection (`::class`, callable references); research Form D7 (::class / callable reference)"
---

## Rule

A `::class` class literal (`Order::class`) and a callable reference (`Helpers::format`)
are usage-site references — and reflection is dynamic regardless. The import-only
extractor emits nothing for them, even with the referenced types in-graph — a
deliberate recall miss, never a false positive.

## Files

```kotlin path=src/m/Order.kt
package com.acme.model
class Order
```

```kotlin path=src/u/Helpers.kt
package com.acme.util
object Helpers {
  fun format() {}
}
```

```kotlin path=src/c/Use.kt
package com.acme.app
fun f() {
  val k = com.acme.model.Order::class
  val ref = com.acme.util.Helpers::format
}
```

## Expect

- silence      # `::class` and callable references are usage-site/dynamic → import-only emits nothing

## Why

Class literals and callable references are usage sites (and reflection is dynamic); the
import-only design silences them.
