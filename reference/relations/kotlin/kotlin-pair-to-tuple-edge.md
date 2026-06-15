---
id: kotlin-pair-to-tuple-edge
language: kotlin
category: usage-site
expectation: edge
cites: "Kotlin spec — Scopes (tuple element types); research Form D13 (Pair / to tuple)"
---

## Rule

`Pair`/`to` tuple element types (`Pair<com.acme.model.Order, com.acme.model.Receipt>`)
sit in TYPE positions inside the generic argument list. `Pair`/`to` themselves are
stdlib, but each element type written as an inline fully-qualified name is shadow-free
and resolves through the shared SymbolTable exactly like an import, so it is a real
edge.

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

- src/c/Use.kt:2 -> node:m      # the tuple element types as inline FQNs are type-position refs → real edge

## Why

The tuple element types sit in TYPE positions; written as inline fully-qualified names
they are shadow-free, so they resolve like imports and produce a real edge. `Pair` is
stdlib and does not suppress the inner fully-qualified element types.
