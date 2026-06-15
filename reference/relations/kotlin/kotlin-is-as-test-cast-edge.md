---
id: kotlin-is-as-test-cast-edge
language: kotlin
category: usage-site
expectation: edge
cites: "Kotlin spec — Scopes (smart-cast subject type); research Form D4 (is/as test+cast)"
---

## Rule

An `is` type test and an `as` cast (`if (x is com.acme.model.Order)`,
`x as com.acme.model.Receipt`) name a type in a TYPE position. When that type is
written as an inline fully-qualified name the FQN is shadow-free and resolves through
the shared SymbolTable exactly like an import, so each is a real edge.

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

- src/c/Use.kt:3 -> node:m      # the `is` test type as an inline FQN is a type-position ref → real edge
- src/c/Use.kt:4 -> node:m      # the `as` cast type as an inline FQN is a type-position ref → real edge

## Why

Cast and type-test operand types are TYPE positions; written as inline fully-qualified
names they are shadow-free, so they resolve like imports and each is a real edge.
