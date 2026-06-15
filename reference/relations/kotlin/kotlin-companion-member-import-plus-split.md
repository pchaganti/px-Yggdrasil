---
id: kotlin-companion-member-import-plus-split
language: kotlin
category: nested
expectation: edge
cites: "Kotlin spec — Packages and imports (import from object/companion); research Form A8/F2f"
---

## Rule

A companion-member import `import a.b.C.Companion.create` resolves to C's file via the
guarded `+`-split at the declared-type boundary: the defining file keys the companion
member `com.acme.C+Companion+create` (C is a declared type → `Companion` is its
companion-object boundary, `create` its member). The dotted import splits onto that
exact `+` key and binds the declaring node.

## Files

```kotlin path=src/x/C.kt
package com.acme
class C {
  companion object {
    fun create() {}
  }
}
```

```kotlin path=src/c/Use.kt
package com.app
import com.acme.C.Companion.create
class D
```

## Expect

- src/c/Use.kt:2 -> node:x      # `com.acme.C.Companion.create` splits to the `com.acme.C+Companion+create` decl key (node x)

## Why

Splitting at the declared-type boundary recovers the real member declaration key;
reading the member chain as deeper packages would mis-resolve it.
