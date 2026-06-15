---
id: kotlin-multi-import-one-edge-each
language: kotlin
category: import
expectation: edge
cites: "Kotlin spec — Packages and imports (per-import FQN); research Form A3/F2a (multi-import)"
---

## Rule

A file with multiple `import` directives produces one FQN edge per import, each
resolved independently by its exact dotted path. `import com.acme.a.Alpha` and
`import com.acme.b.Beta` each bind their own declaring node.

## Files

```kotlin path=src/a/Alpha.kt
package com.acme.a
class Alpha
```

```kotlin path=src/b/Beta.kt
package com.acme.b
class Beta
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.a.Alpha
import com.acme.b.Beta
class C
```

## Expect

- src/c/Use.kt:2 -> node:a      # `import com.acme.a.Alpha` binds node a
- src/c/Use.kt:3 -> node:b      # `import com.acme.b.Beta` binds node b

## Why

Each import is its own dependency; the edge set is exactly the set of imported
FQNs that resolve to a mapped node.
