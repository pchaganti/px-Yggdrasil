---
id: kotlin-constructor-call-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Scopes (ctor name = type name); research Form D8 (constructor call, incl. stdlib ctor)"
---

## Rule

A constructor call (`com.acme.model.Order()`) is in EXPRESSION position. It parses as a
`navigation_expression` / member-access chain that is syntactically indistinguishable
from `localVariable.field.method`, so resolving it could bind the wrong target — the
extractor therefore emits nothing for it. Stdlib ctors (`Result.success(...)`,
`Pair(1, 2)`) additionally carry the stdlib-collision trap. All stay silent — a
zero-false-positive boundary. (An inline FQN in a TYPE position is shadow-free and DOES
edge; the distinction is the syntactic position, not the FQN.)

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

- silence      # constructor calls (incl. stdlib `Result`/`Pair`) are in expression position → indistinguishable from a member-access chain → silent (zero-FP boundary)

## Why

A constructor call sits in expression position and parses as a member-access chain
indistinguishable from `localVariable.field.method`; binding it could pick the wrong
target, so it is deliberately silent. The stdlib ctor trap makes a bare-name guess
doubly dangerous. A fully-qualified name in TYPE position has no such ambiguity and does
edge — the boundary is the syntactic position.
