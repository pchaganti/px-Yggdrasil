---
id: kotlin-wildcard-import-package-hint-silence
language: kotlin
category: import
expectation: silence
cites: "Kotlin spec — Packages and imports (star-import names a package); research Form A6/F2c"
---

## Rule

A wildcard `import a.b.*` names a PACKAGE, not a declaration. The `*` is a separate
token; the emitted hint is the package FQN (`com.acme.orders`), with no `*`.
Declarations are per-type (`com.acme.orders.Order`), never the bare package, so the
wildcard hint matches no declaration and resolves to nothing — EVEN when a per-type
declaration of that package IS in-graph. Expanding a wildcard to "every type in the
package" is forbidden (over-broad, FP-risk).

## Files

```kotlin path=src/o/Order.kt
package com.acme.orders
class Order
```

```kotlin path=src/c/Use.kt
package com.app
import com.acme.orders.*
class C
```

## Expect

- silence      # the wildcard hint is the package FQN `com.acme.orders`; no per-type decl matches it → no edge (expansion forbidden)

## Why

Attributing the edge to every file in the package over-broadens, and a wildcard may
import zero used names; silencing it is the safe under-detect direction.
