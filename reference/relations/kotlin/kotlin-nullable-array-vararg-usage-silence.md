---
id: kotlin-nullable-array-vararg-usage-silence
language: kotlin
category: usage-site
expectation: edge
cites: "Kotlin spec — Scopes (nullable/array/vararg element types); research Form D14/D15/D16"
---

## Rule

A nullable `T?`, an `Array<T>`, and a `vararg` element type each carry a type in a TYPE
position (`?` is nullability syntax; `Array`/`IntArray` are stdlib wrappers). When the
element type is written as an inline fully-qualified name (`com.acme.model.Order`) the
FQN is shadow-free and resolves through the shared SymbolTable exactly like an import,
so each is a real edge.

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

- src/c/Use.kt:3 -> node:m      # the nullable element type as an inline FQN is a type-position ref → real edge
- src/c/Use.kt:4 -> node:m      # the array element type as an inline FQN is a type-position ref → real edge
- src/c/Use.kt:5 -> node:m      # the vararg element type as an inline FQN is a type-position ref → real edge

## Why

The element type sits in a TYPE position in each form; written as an inline
fully-qualified name it is shadow-free, so it resolves like an import and is a real
edge. `?` is syntax and `Array` is a stdlib wrapper — neither suppresses the inner
fully-qualified element type.
