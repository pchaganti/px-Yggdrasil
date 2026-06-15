---
id: kotlin-nested-import-plus-split-edge
language: kotlin
category: nested
expectation: edge
cites: "Kotlin docs — Nested and inner classes (nested import `Outer.Inner`); research Form A9/F4"
---

## Rule

The correct nested import `import a.b.Outer.Inner` resolves via the guarded `+`-split:
`com.acme.Outer` is a declared type, so the tail `Inner` splits onto the `+` boundary,
keying `com.acme.Outer+Inner` — the nested declaration. It binds the declaring node.

## Files

```kotlin path=src/a/Outer.kt
package com.acme
class Outer {
  class Inner
}
```

```kotlin path=src/c/Use.kt
package com.x
import com.acme.Outer.Inner
class C
```

## Expect

- src/c/Use.kt:2 -> node:a      # `com.acme.Outer.Inner` splits at the declared-type boundary to `com.acme.Outer+Inner` (node a)

## Why

Splitting only at a declared-type boundary recovers the real nested-type key while
never reading the chain as deeper packages.
