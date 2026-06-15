---
id: kotlin-fully-qualified-inline-ref-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Scopes (qualified inline reference); research Form D18 (fully-qualified inline ref)"
---

## Rule

A fully-qualified inline reference written as a CONSTRUCTOR CALL
(`com.acme.metrics.Timer()`) is in EXPRESSION position, not type position. It parses as
a `navigation_expression` / member-access chain that is syntactically indistinguishable
from `localVariable.field.method`, so resolving it could bind the wrong target. The
extractor therefore emits nothing for it — deliberately silent, a zero-false-positive
boundary. (An inline FQN in a TYPE position — a parameter/return/property type, a
supertype, an `is`/`as` type, a generic argument — is shadow-free and DOES edge; the
distinction is the syntactic position, not the FQN itself.)

## Files

```kotlin path=src/metrics/Timer.kt
package com.acme.metrics
class Timer
```

```kotlin path=src/c/Use.kt
package com.acme.app
fun f() { val o = com.acme.metrics.Timer() }
```

## Expect

- silence      # a fully-qualified CONSTRUCTOR CALL is in expression position → indistinguishable from a member-access chain → silent (zero-FP boundary)

## Why

A constructor call sits in expression position and parses as a member-access chain
indistinguishable from `localVariable.field.method`; binding it could pick the wrong
target, so it is deliberately silent. A fully-qualified name in TYPE position has no
such ambiguity and does edge — the boundary is the syntactic position.
