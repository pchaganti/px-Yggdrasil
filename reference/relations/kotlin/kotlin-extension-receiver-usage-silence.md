---
id: kotlin-extension-receiver-usage-silence
language: kotlin
category: usage-site
expectation: edge
cites: "Kotlin spec — Scopes (extension receiver type); research Form D10 (extension receiver type)"
---

## Rule

An extension-function receiver type (`fun com.acme.model.Order.summary()`) sits in a
TYPE position. Written as an inline fully-qualified name the FQN is shadow-free and
resolves through the shared SymbolTable exactly like an import, so it is a real edge.

## Files

```kotlin path=src/m/Order.kt
package com.acme.model
class Order
```

```kotlin path=src/c/Use.kt
package com.acme.app
fun com.acme.model.Order.summary(): String = ""
```

## Expect

- src/c/Use.kt:2 -> node:m      # the extension receiver type as an inline FQN is a type-position ref → real edge

## Why

The receiver type sits in a TYPE position; written as an inline fully-qualified name it
is shadow-free, so it resolves like an import and is a real edge.
