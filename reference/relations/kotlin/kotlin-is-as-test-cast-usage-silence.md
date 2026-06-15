---
id: kotlin-is-as-test-cast-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Scopes (smart-cast subject type); research Form D4 (is/as test+cast)"
---

## Rule

An `is` type test and an `as` cast (`if (x is Order)`, `x as Receipt`) are usage-site
type references. The import-only extractor emits nothing for them, even with the
referenced types in-graph — a deliberate recall miss, never a false positive.

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
fun f(x: Any) {
  if (x is com.acme.model.Order) {}
  val y = x as com.acme.model.Receipt
}
```

## Expect

- silence      # `is` test and `as` cast are usage sites → import-only emits nothing

## Why

Cast and type-test operand types are usage sites; the import-only design tolerates the
recall gap rather than risk the precedence trap.
