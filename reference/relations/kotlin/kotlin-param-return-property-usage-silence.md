---
id: kotlin-param-return-property-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Scopes (declaration-site type refs); research Form D5 (param/return/property)"
---

## Rule

Parameter, return, and property types (`fun m(l: Logger): Result`, `val r: Repo?`) are
usage-site type references. The import-only extractor emits nothing for them, even
with the referenced types in-graph — a deliberate recall miss, never a false positive.

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

- silence      # param / return / property types are usage sites → import-only emits nothing

## Why

Declaration-header type positions are usage sites; binding them by simple name is the
precedence-trap door the import-only design closes.
