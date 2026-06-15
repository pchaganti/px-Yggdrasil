---
id: kotlin-plain-import-sibling-same-name-trap
language: kotlin
category: trap
expectation: edge
cites: "Kotlin spec — Packages and imports (exact FQN binding); research Form A3/F2a (sibling same-name trap)"
---

## Rule

When two nodes each declare a type with the SAME simple name in DIFFERENT packages,
a plain import binds ONLY the package it actually names. `import com.acme.payments.Gateway`
must bind the node declaring `com.acme.payments.Gateway`, never the sibling
`com.vendor.Gateway` that shares the simple name `Gateway`. The full dotted FQN is
the key; the simple name alone is never the binding axis.

## Files

```kotlin path=src/pay/Gateway.kt
package com.acme.payments
class Gateway
```

```kotlin path=src/vend/Gateway.kt
package com.vendor
class Gateway
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.payments.Gateway
class C
```

## Expect

- src/c/Use.kt:2 -> node:pay      # the import binds `com.acme.payments.Gateway` (node pay), never the sibling `com.vendor.Gateway` (node vend)

## Why

This is the decisive false-positive class: a same-simple-name type in another
package must NOT be chosen over the imported FQN. The exact dotted key rejects it.
