---
id: kotlin-constructor-call-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Scopes (ctor name = type name); research Form D8 (constructor call, incl. stdlib ctor)"
---

## Rule

A constructor call (`Order()`) is a usage-site reference (the ctor name is the type
name), and stdlib ctors (`Result.success(...)`, `Pair(1, 2)`) carry the stdlib-collision
trap. The import-only extractor emits nothing for any of them, even with the project
type in-graph — a deliberate recall miss, never a false positive.

## Files

```kotlin path=src/m/Order.kt
package com.acme.model
class Order
```

```kotlin path=src/c/Use.kt
package com.acme.app
fun f() {
  val o = com.acme.model.Order()
  val r = Result.success(1)
  val p = Pair(1, 2)
}
```

## Expect

- silence      # constructor calls (incl. stdlib `Result`/`Pair`) are usage sites → import-only emits nothing

## Why

A ctor call is a usage site whose name equals the type; the stdlib ctor trap makes
bare-name binding doubly dangerous, so it stays silent.
