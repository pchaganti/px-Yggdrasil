---
id: kotlin-member-chain-not-subpackage-silence
language: kotlin
category: trap
expectation: silence
cites: "Kotlin spec — Packages and imports (member ≠ sub-package); research Form A7/F2e (member-not-a-sub-package)"
---

## Rule

A trailing member segment in `a.b.Color.RED` must NEVER be read as a deeper package.
The guarded `+`-split fires ONLY when the prefix `a.b.Color` is itself a declared
TYPE. Here `com.acme.model` declares only an unrelated `Something` — there is no
`Color` type and no top-level `com.acme.model.Color.RED` — so neither the verbatim
dotted key nor any guarded split binds. The import resolves to nothing.

## Files

```kotlin path=src/o/Other.kt
package com.acme.model
class Something
```

```kotlin path=src/c/Use.kt
package com.app
import com.acme.model.Color.RED
class C
```

## Expect

- silence      # `com.acme.model.Color` is not a declared type → no split fires; reading `Color.RED` as a sub-package is forbidden → no edge

## Why

Reading the member chain as a sub-package would manufacture a phantom target on a
path resolver; the declared-type-boundary guard keeps the symbol axis sound.
