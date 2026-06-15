---
id: kotlin-delegation-by-usage-silence
language: kotlin
category: usage-site
expectation: edge
cites: "Kotlin docs — Delegated properties / Delegation; research Form D11 (delegation by)"
---

## Rule

Delegation (`class C : Iface by impl`) names a delegated type in the supertype list — a
TYPE position. When the delegated interface is written as an inline fully-qualified name
(`com.acme.flow.Iface`) the FQN is shadow-free and resolves through the shared
SymbolTable like an import, so it is a real edge. `val p by lazy {}` names `lazy`
(stdlib) at a usage site and stays silent.

## Files

```kotlin path=src/flow/Iface.kt
package com.acme.flow
interface Iface
```

```kotlin path=src/c/Use.kt
package com.acme.app
class C(impl: com.acme.flow.Iface) : com.acme.flow.Iface by impl {
  val p by lazy { 1 }
}
```

## Expect

- src/c/Use.kt:2 -> node:flow      # the delegated supertype as an inline FQN (`com.acme.flow.Iface`) is a type-position ref → real edge

## Why

The delegated type sits in the supertype list — a TYPE position — and written as an
inline fully-qualified name it is shadow-free, so it resolves like an import and is a
real edge. `lazy` is stdlib at a usage site and stays silent.
