---
id: kotlin-generic-argument-where-usage-silence
language: kotlin
category: usage-site
expectation: edge
cites: "Kotlin spec — Overload resolution / Scopes; research Form D2/D3 (generic argument + where)"
---

## Rule

A generic type argument (`List<com.acme.model.Order>`) and a `where` constraint
(`where T : com.acme.model.Comparable<T>`) sit in TYPE positions. When the argument /
constraint type is written as an inline fully-qualified name the FQN is shadow-free and
resolves through the shared SymbolTable exactly like an import, so each is a real edge.

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

- src/c/Use.kt:2 -> node:m      # the generic argument type as an inline FQN is a type-position ref → real edge
- src/c/Use.kt:3 -> node:m      # the where-constraint type as an inline FQN is a type-position ref → real edge

## Why

Generic argument and `where` constraint positions are TYPE positions; written as inline
fully-qualified names the types are shadow-free, so they resolve like imports and each
is a real edge.
