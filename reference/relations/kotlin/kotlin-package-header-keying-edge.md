---
id: kotlin-package-header-keying-edge
language: kotlin
category: import
expectation: edge
cites: "Kotlin spec — Packages and imports (package header, not directory); research Form A1/F1"
---

## Rule

A file's package comes from its `package` header, NOT its directory. Every
top-level declaration is keyed `<package>.<SimpleName>`. So a `class Order` and a
top-level `fun place()` in `package com.acme.orders` feed the SymbolTable as
`com.acme.orders.Order` and `com.acme.orders.place`. An import of either exact FQN
from another node binds the declaring file — proving the package-header keying.

## Files

```kotlin path=src/o/Orders.kt
package com.acme.orders
class Order
fun place() {}
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.orders.Order
import com.acme.orders.place
class C
```

## Expect

- src/c/Use.kt:2 -> node:o      # `com.acme.orders.Order` is keyed from the package header (node o)
- src/c/Use.kt:3 -> node:o      # top-level `com.acme.orders.place` likewise keyed `<package>.<name>` (node o)

## Why

Inferring the package from the directory (the Java convention) would mis-bind a
reference under a non-conventional layout; reading the `package` header is the
symbol-axis source of truth.
