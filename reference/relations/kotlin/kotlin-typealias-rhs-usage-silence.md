---
id: kotlin-typealias-rhs-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin docs — Type aliases (no new type; RHS is a usage-site ref); research Form D9 (typealias RHS)"
---

## Rule

A `typealias` does not introduce a new type; its right-hand side (`Long`, `A.Inner`)
is a usage-site type reference. The alias NAME is indexed as a declaration (so others
can import it), but the RHS is NOT extracted. The import-only extractor emits nothing
for the RHS, even when the RHS type is in-graph — a deliberate recall miss, never a
false positive.

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

- silence      # the alias RHS is a usage-site type ref → not extracted; only the alias NAME is a declaration

## Why

The RHS names an underlying type at a usage site; the alias adds no new type, so the
RHS edge is a recall gap, not an FP.
