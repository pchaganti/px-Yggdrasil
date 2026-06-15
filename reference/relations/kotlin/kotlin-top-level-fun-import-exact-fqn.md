---
id: kotlin-top-level-fun-import-exact-fqn
language: kotlin
category: import
expectation: edge
cites: "Kotlin docs — Packages and imports (top-level functions/properties importable); research Form A4/F2b"
---

## Rule

A top-level function or property is importable by its exact FQN — Kotlin has no
enclosing class for top-level members. `import com.acme.util.retry` keys
`com.acme.util.retry` (the exact dotted FQN), never the bare simple name `retry`.
Binding by the simple name alone would be a false positive — two packages may each
define a top-level `retry`.

## Files

```kotlin path=src/u/Util.kt
package com.acme.util
fun retry() {}
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.util.retry
class C
```

## Expect

- src/c/Use.kt:2 -> node:u      # `import com.acme.util.retry` binds the exact FQN (node u), never the bare `retry`

## Why

The hint carries the full dotted FQN, so a top-level member is bound by its exact
path; the simple name is never the key.
