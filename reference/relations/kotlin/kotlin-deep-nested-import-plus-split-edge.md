---
id: kotlin-deep-nested-import-plus-split-edge
language: kotlin
category: nested
expectation: edge
cites: "Kotlin docs — Nested and inner classes (deep nesting); research Form A9/F4 (deeper nesting)"
---

## Rule

Deeper nesting chains recursively: `A.B.Deep` keys `A+B+Deep`. The defining file
declares `com.acme.A`, `com.acme.A+B`, `com.acme.A+B+Deep`. A consumer's
`import com.acme.A.B.Deep` resolves via the guarded `+`-split at each declared-type
boundary to `com.acme.A+B+Deep` and binds the declaring node.

## Files

```kotlin path=src/a/A.kt
package com.acme
class A {
  class B {
    class Deep
  }
}
```

```kotlin path=src/c/Use.kt
package com.x
import com.acme.A.B.Deep
class C
```

## Expect

- src/c/Use.kt:2 -> node:a      # `com.acme.A.B.Deep` splits to `com.acme.A+B+Deep` (node a) at the declared-type boundaries

## Why

Recursive declared-type-boundary splitting recovers arbitrarily deep nested keys
without ever reading an inner type as a sub-package.
