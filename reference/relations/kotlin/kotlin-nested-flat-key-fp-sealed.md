---
id: kotlin-nested-flat-key-fp-sealed
language: kotlin
category: trap
expectation: silence
cites: "Kotlin docs — Nested and inner classes (nested ≠ top-level); research Form C1/F4 (SEALED flat-key FP)"
---

## Rule

A nested declaration is keyed by its enclosing-TYPE chain joined with `+`
(`com.acme.Outer+Inner`), NEVER flat as the phantom top-level `com.acme.Inner`. In
Kotlin a top-level `import com.acme.Inner` names a TOP-LEVEL type in package
`com.acme` — never the nested `Outer.Inner` (whose import is `com.acme.Outer.Inner`).
The `+` key lives in a string space disjoint from the dot-only namespace, so a
top-level import of the nested simple name finds nothing → silence. (Flat-keying it
was a genuine false positive, now sealed.)

## Files

```kotlin path=src/a/Outer.kt
package com.acme
class Outer {
  class Inner
}
```

```kotlin path=src/c/Use.kt
package com.x
import com.acme.Inner
class C
```

## Expect

- silence      # the nested `Inner` keys `com.acme.Outer+Inner`, not flat `com.acme.Inner`; the top-level import binds nothing

## Why

Flat-keying a nested type manufactured a phantom top-level FQN that a top-level import
mis-bound to the nesting file — the FP the cardinal invariant forbids. Separator
isolation (`+` vs `.`) seals it.
