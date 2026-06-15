---
id: kotlin-jvmname-no-facade-key-edge
language: kotlin
category: import
expectation: edge
cites: "Kotlin docs — Packages and imports; Baeldung — JVM Platform Annotations (`@JvmName` facade); research Form C2/F8"
---

## Rule

`@file:JvmName("OrderUtils")` renames the JVM facade class for Java interop only — a
bytecode artifact, NOT a Kotlin source symbol. The Kotlin FQN is unchanged: a top-level
`fun place()` in `package com.acme.orders` keeps the key `com.acme.orders.place`. No
`<File>Kt` / `OrderUtils` facade key is synthesized. A consumer's
`import com.acme.orders.place` therefore binds the declaring file, and no facade-path
edge is ever produced (the runner's no-unexpected-edge check confirms it).

## Files

```kotlin path=src/o/Orders.kt
@file:JvmName("OrderUtils")
package com.acme.orders
class Order
fun place() {}
val DEFAULT = 0
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.orders.place
class C
```

## Expect

- src/c/Use.kt:2 -> node:o      # the Kotlin FQN `com.acme.orders.place` is unchanged by `@file:JvmName` (node o); no facade key invented

## Why

Inventing a `<File>Kt` facade boundary would bind Kotlin references through a class that
never appears in Kotlin source; ignoring `@JvmName` keeps the real FQN the only key.
