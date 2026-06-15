---
id: kotlin-when-subject-smartcast-usage-silence
language: kotlin
category: usage-site
expectation: edge
cites: "Kotlin spec — Scopes (when-branch smart cast); research Form D12 (when-subject smart cast)"
---

## Rule

A `when`-branch type test (`when (x) { is com.acme.model.Order -> }`) names a type in a
TYPE position. When written as an inline fully-qualified name the FQN is shadow-free and
resolves through the shared SymbolTable exactly like an import, so it is a real edge.

## Files

```kotlin path=src/m/Order.kt
package com.acme.model
class Order
```

```kotlin path=src/c/Use.kt
package com.acme.app
fun f(x: Any) = when (x) {
  is com.acme.model.Order -> 1
  else -> 0
}
```

## Expect

- src/c/Use.kt:3 -> node:m      # the `when`-branch type test as an inline FQN is a type-position ref → real edge

## Why

The `when`-branch type test sits in a TYPE position; written as an inline
fully-qualified name it is shadow-free, so it resolves like an import and is a real
edge.
