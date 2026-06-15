---
id: kotlin-fully-qualified-inline-ref-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Scopes (qualified inline reference); research Form D18 (fully-qualified inline ref)"
---

## Rule

A fully-qualified inline reference (`com.acme.metrics.Timer()`) is the one
provably-safe recall extension the decision flags for owner review — NOT
auto-implemented. Current behavior: the import-only extractor emits nothing for it,
even with the referenced type in-graph — a deliberate recall miss, never a false
positive.

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

- silence      # a fully-qualified inline reference is a usage site → import-only emits nothing (recall extension deferred to owner review)

## Why

Even the unambiguous fully-qualified inline form is left silent in v1 — promoting it
is an owner decision, not an automatic recall add.
