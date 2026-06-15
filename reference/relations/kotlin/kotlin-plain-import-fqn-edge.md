---
id: kotlin-plain-import-fqn-edge
language: kotlin
category: import
expectation: edge
cites: "Kotlin spec — Packages and imports (import grammar `import a.b.C`); research Form A3/F2a"
---

## Rule

A plain `import a.b.C` introduces the last segment bound to the fully-qualified
symbol `a.b.C`. The import operand IS the per-type edge: it resolves through the
shared SymbolTable by its exact dotted FQN against the declaring file's
`<package>.<SimpleName>` key. So `import com.acme.payments.PaymentService` is a
real dependency on the node declaring that exact FQN — never on a coincidental
same-simple-name type in another package.

## Files

```kotlin path=src/pay/PaymentService.kt
package com.acme.payments
class PaymentService
```

```kotlin path=src/c/Use.kt
package com.acme.app
import com.acme.payments.PaymentService
class C
```

## Expect

- src/c/Use.kt:2 -> node:pay      # `import com.acme.payments.PaymentService` binds the exact FQN (node pay)

## Why

Binding by the exact FQN is the safe direction; the imported symbol's full dotted
path is the key, so an unrelated same-named type elsewhere can never be chosen.
