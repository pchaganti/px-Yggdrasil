---
id: kotlin-multiple-top-level-decls-one-key-each
language: kotlin
category: import
expectation: edge
cites: "Kotlin docs — Packages and imports (no source class boundary around top-level members); research Form C2/F8"
---

## Rule

A `.kt` file may hold many top-level declarations, all sharing the file's `package`;
at the source level there is NO class boundary around them. Each keys as one FQN under
the same package — `Order`, `place`, `DEFAULT`, `Money` all become
`com.acme.orders.<name>`. A consumer importing any of those exact FQNs binds the
declaring file.

## Files

```kotlin path=src/o/Orders.kt
package com.acme.orders
class Order
fun place() {}
val DEFAULT = 0
typealias Money = Long
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.orders.Order
import com.acme.orders.place
import com.acme.orders.DEFAULT
import com.acme.orders.Money
class C
```

## Expect

- src/c/Use.kt:2 -> node:o      # `com.acme.orders.Order`
- src/c/Use.kt:3 -> node:o      # `com.acme.orders.place`
- src/c/Use.kt:4 -> node:o      # `com.acme.orders.DEFAULT`
- src/c/Use.kt:5 -> node:o      # `com.acme.orders.Money` (typealias name is a declaration)

## Why

Multiple top-level declarations per file are one FQN each under the same package; no
file-class wrapper is keyed, so each is independently importable.
