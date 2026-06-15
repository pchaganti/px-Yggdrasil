---
id: kotlin-object-member-import-plus-split
language: kotlin
category: nested
expectation: edge
cites: "Kotlin spec — Packages and imports (object members importable); research Form A8/F2f"
---

## Rule

An object-member import `import a.b.Obj.bar` resolves to the object's file via the
guarded `+`-split at the declared-type boundary: the defining file keys the object
member `com.acme.Registry+lookup` (`Registry` is a declared object → `lookup` its
member). The dotted import splits onto that `+` key and binds the declaring node.

## Files

```kotlin path=src/r/Registry.kt
package com.acme
object Registry {
  fun lookup() {}
}
```

```kotlin path=src/c/Use.kt
package com.app
import com.acme.Registry.lookup
class D
```

## Expect

- src/c/Use.kt:2 -> node:r      # `com.acme.Registry.lookup` splits to the `com.acme.Registry+lookup` decl key (node r)

## Why

An object is a declared-type boundary; splitting there recovers the member key, while
treating the member as a deeper package would mis-resolve it.
