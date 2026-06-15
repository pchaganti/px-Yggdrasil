---
id: kotlin-typealias-rhs-usage-silence
language: kotlin
category: usage-site
expectation: edge
cites: "Kotlin docs — Type aliases (no new type; RHS is a usage-site ref); research Form D9 (typealias RHS)"
---

## Rule

A `typealias` does not introduce a new type; its right-hand side names an underlying
type in a TYPE position. The alias NAME is indexed as a declaration (so others can
import it). When the RHS is written as an inline fully-qualified name
(`com.acme.A.Inner`) the FQN is shadow-free and resolves through the shared SymbolTable
exactly like an import, so it is a real edge — here `com.acme.A.Inner` is a nested type
resolved via the declared-type `+`-split. A stdlib RHS (`Long`) stays silent.

## Files

```kotlin path=src/a/A.kt
package com.acme
class A {
  class Inner
}
```

```kotlin path=src/c/Use.kt
package com.acme.app
typealias Money = Long
typealias AInner = com.acme.A.Inner
```

## Expect

- src/c/Use.kt:3 -> node:a      # the alias RHS as an inline FQN (`com.acme.A.Inner`, a nested type via `+`-split) is a type-position ref → real edge

## Why

The alias RHS names an underlying type in a TYPE position; written as an inline
fully-qualified name it is shadow-free, so it resolves like an import and is a real
edge. The nested type `com.acme.A.Inner` is keyed through the declared-type `+`-split.
