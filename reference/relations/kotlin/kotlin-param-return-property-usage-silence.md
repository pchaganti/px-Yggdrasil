---
id: kotlin-param-return-property-usage-silence
language: kotlin
category: usage-site
expectation: edge
cites: "Kotlin spec — Scopes (declaration-site type refs); research Form D5 (param/return/property)"
---

## Rule

Parameter, return, and property types (`fun m(l: com.acme.Logger): com.acme.Result`,
`val r: com.acme.Repo?`) sit in TYPE positions. When written as inline fully-qualified
names the FQNs are shadow-free and resolve through the shared SymbolTable exactly like
imports, so each is a real edge.

## Files

```kotlin path=src/d/Repo.kt
package com.acme
class Repo
```

```kotlin path=src/d/Logger.kt
package com.acme
class Logger
```

```kotlin path=src/d/Result.kt
package com.acme
class Result
```

```kotlin path=src/c/Use.kt
package com.acme.app
class C {
  val r: com.acme.Repo? = null
  fun m(l: com.acme.Logger): com.acme.Result = TODO()
}
```

## Expect

- src/c/Use.kt:3 -> node:d      # the property type as an inline FQN is a type-position ref → real edge
- src/c/Use.kt:4 -> node:d      # the parameter and return types as inline FQNs are type-position refs → real edge

## Why

Declaration-header type positions (parameter, return, property) are TYPE positions;
written as inline fully-qualified names they are shadow-free, so they resolve like
imports and each is a real edge.
