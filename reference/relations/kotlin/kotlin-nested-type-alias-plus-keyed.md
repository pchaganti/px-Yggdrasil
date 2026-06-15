---
id: kotlin-nested-type-alias-plus-keyed
language: kotlin
category: nested
expectation: edge
cites: "Kotlin docs — Type aliases (nested aliases scope as nested classes); What's new in Kotlin 2.3.0 — nested type aliases Stable; research Form E7"
---

## Rule

A nested `typealias` (Beta 2.2 → Stable 2.3) declared inside a class/interface/object
keys EXACTLY like a nested class: its enclosing-TYPE chain joined to its name with `+`.
So `class A { typealias Inner = … }` keys `com.acme.A+Inner` — NEVER the flat
`com.acme.Inner` (which would be the sealed nested-class FP). A consumer's
`import com.acme.A.Inner` resolves via the guarded `+`-split at the declared-type
boundary `com.acme.A`. The alias RHS is a usage-site reference (silenced).

## Files

```kotlin path=src/a/A.kt
package com.acme
class A {
  typealias Inner = com.acme.Thing
}
```

```kotlin path=src/c/Use.kt
package com.x
import com.acme.A.Inner
class C
```

## Expect

- src/c/Use.kt:2 -> node:a      # `com.acme.A.Inner` splits to the nested-alias key `com.acme.A+Inner` (node a); never flat-keyed `com.acme.Inner`

## Why

Flat-keying a nested alias would manufacture the same phantom top-level FQN sealed for
nested classes; keying it `Outer+Alias` (which the existing enclosing-type-chain logic
already does for any `type_alias`) keeps it in the isolated `+` string space.
