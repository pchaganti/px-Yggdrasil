---
id: kotlin-when-subject-smartcast-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Scopes (when-branch smart cast); research Form D12 (when-subject smart cast)"
---

## Rule

A `when`-branch type test (`when (x) { is Order -> }`) is a usage-site type reference.
The import-only extractor emits nothing for it, even with the branch type in-graph — a
deliberate recall miss, never a false positive.

## Files

```kotlin path=src/m/Order.kt
package com.acme.model
class Order
```

```kotlin path=src/c/Use.kt
package com.acme.app
fun f(x: Any) = when (x) {
  is com.acme.model.Order -> 1
  else -> 0
}
```

## Expect

- silence      # the `when`-branch type is a usage site → import-only emits nothing

## Why

The branch type sits at a usage site; the import-only design tolerates the recall gap.
