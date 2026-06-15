---
id: kotlin-delegation-by-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin docs — Delegated properties / Delegation; research Form D11 (delegation by)"
---

## Rule

Delegation (`class C : Iface by impl`, `val p by lazy {}`) names a delegated type at a
usage site, and `lazy` is stdlib. The import-only extractor emits nothing for them,
even with the delegated interface in-graph — a deliberate recall miss, never a false
positive.

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

- silence      # delegated type + `by lazy` are usage sites → import-only emits nothing

## Why

The delegated type is a usage site and `lazy` is stdlib; the import-only design
silences both.
