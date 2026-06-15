---
id: kotlin-supertype-list-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Overload resolution / Scopes (usage-site precedence); research Form D1 (supertype/interface list)"
---

## Rule

A supertype / interface list `class C : Base(), Iface` is a usage-site type reference.
The import-only extractor extracts edges ONLY from `import` directives — it performs
NO usage-site refinement — so the supertype references emit nothing, even when the
referenced types are in-graph. This is a deliberate tolerated false-negative (recall
miss), never a false positive. Binding a supertype by simple name would reintroduce
the precedence + stdlib-collision FP traps and is forbidden.

## Files

```kotlin path=src/base/Base.kt
package com.acme.base
open class Base
```

```kotlin path=src/flow/Iface.kt
package com.acme.flow
interface Iface
```

```kotlin path=src/c/Use.kt
package com.acme.app
class C : com.acme.base.Base(), com.acme.flow.Iface
```

## Expect

- silence      # the supertype list is a usage site; import-only emits nothing even though Base/Iface are in-graph

## Why

A real cross-file dependency carried only by a supertype is a recall gap the
one-directional check tolerates; never an FP.
