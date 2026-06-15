---
id: kotlin-supertype-list-usage-silence
language: kotlin
category: usage-site
expectation: edge
cites: "Kotlin spec — Overload resolution / Scopes (usage-site precedence); research Form D1 (supertype/interface list)"
---

## Rule

A supertype / interface list `class C : com.acme.base.Base(), com.acme.flow.Iface`
names each supertype in a TYPE position. When a supertype is written as an inline
fully-qualified name the FQN is shadow-free and resolves through the shared SymbolTable
exactly like an import, so each is a real edge. (A simple-name supertype would carry the
precedence + stdlib-collision traps and stays silent, but a fully-qualified name has no
such ambiguity.)

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

- src/c/Use.kt:2 -> node:base      # the superclass as an inline FQN (`com.acme.base.Base`) is a type-position ref → real edge
- src/c/Use.kt:2 -> node:flow      # the interface as an inline FQN (`com.acme.flow.Iface`) is a type-position ref → real edge

## Why

Each supertype sits in a TYPE position; written as an inline fully-qualified name it is
shadow-free, so it resolves like an import and is a real cross-node edge.
