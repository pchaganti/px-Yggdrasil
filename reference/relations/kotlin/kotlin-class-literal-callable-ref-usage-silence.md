---
id: kotlin-class-literal-callable-ref-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin docs — Reflection (`::class`, callable references); research Form D7 (::class / callable reference)"
---

## Rule

A `::class` class literal (`com.acme.model.Order::class`) and a `::member` callable
reference (`com.acme.util.Helpers::format`) are in EXPRESSION position. Each parses as a
`navigation_expression` / member-access chain that is syntactically indistinguishable
from `localVariable.field.method`, so resolving it could bind the wrong target — and
reflection is dynamic regardless. The extractor therefore emits nothing for them — a
zero-false-positive boundary. (An inline FQN in a TYPE position is shadow-free and DOES
edge; the distinction is the syntactic position, not the FQN.)

## Files

```kotlin path=src/m/Order.kt
package com.acme.model
class Order
```

```kotlin path=src/u/Helpers.kt
package com.acme.util
object Helpers {
  fun format() {}
}
```

```kotlin path=src/c/Use.kt
package com.acme.app
fun f() {
  val k = com.acme.model.Order::class
  val ref = com.acme.util.Helpers::format
}
```

## Expect

- silence      # `::class` and `::member` callable references are in expression position → indistinguishable from a member-access chain → silent (zero-FP boundary)

## Why

A `::class` literal and a callable reference sit in expression position and parse as a
member-access chain indistinguishable from `localVariable.field.method`; binding either
could pick the wrong target, and reflection is dynamic regardless — so both are
deliberately silent. A fully-qualified name in TYPE position has no such ambiguity and
does edge — the boundary is the syntactic position.
