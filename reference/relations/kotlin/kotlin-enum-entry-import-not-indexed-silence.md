---
id: kotlin-enum-entry-import-not-indexed-silence
language: kotlin
category: import
expectation: silence
cites: "Kotlin docs — Packages and imports (enum constants); research Form A7/F2e (enum entry not indexed)"
---

## Rule

When the defining file declares an enum `enum class Color { RED, GREEN }`, the
SymbolTable holds the enum TYPE key `com.acme.model.Color` but NOT the entry
`com.acme.model.Color+RED` (enum entries carry no `name` field and are not indexed as
declarations). A consumer's `import com.acme.model.Color.RED` keys, via the guarded
`+`-split, `com.acme.model.Color+RED` — which is absent → silence. This MISSES the
real dependency on the enum TYPE: a tolerated false-negative (recall miss), never a
false positive.

## Files

```kotlin path=src/m/Color.kt
package com.acme.model
enum class Color {
  RED, GREEN
}
```

```kotlin path=src/c/Use.kt
package com.app
import com.acme.model.Color.RED
class C
```

## Expect

- silence      # `Color+RED` is not indexed (entries carry no name) → the member import resolves to nothing (recall miss, not FP)

## Why

Indexing enum entries (so `Color+RED` exists) or dropping the trailing member to the
bare TYPE key would be a recall add deferred to owner review; silencing the
unindexed entry stays zero-FP today.
