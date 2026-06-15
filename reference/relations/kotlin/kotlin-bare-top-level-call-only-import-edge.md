---
id: kotlin-bare-top-level-call-only-import-edge
language: kotlin
category: import
expectation: edge
cites: "Kotlin spec — Overload resolution (bare call by precedence); research Form D17 (bare top-level call)"
---

## Rule

A bare top-level call (`retry { }`) resolves by precedence at the use site and is NOT
separately extracted — but the explicit `import com.acme.util.retry` that makes the
bare call legal IS the edge, and IS emitted. So the only edge from a file that imports
and then bare-calls a top-level function is the IMPORT edge; the call site adds
nothing.

## Files

```kotlin path=src/u/Util.kt
package com.acme.util
fun retry(block: () -> Unit) {}
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.util.retry
fun g() = retry { }
```

## Expect

- src/c/Use.kt:2 -> node:u      # the IMPORT `com.acme.util.retry` is the edge (node u); the bare call `retry { }` adds nothing

## Why

The import is the unit of the edge; the bare call site is a usage site that would only
refine the relation type, which v1 does not do — so only the import edge survives.
