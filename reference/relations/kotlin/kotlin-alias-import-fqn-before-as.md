---
id: kotlin-alias-import-fqn-before-as
language: kotlin
category: import
expectation: edge
cites: "Kotlin spec — Packages and imports (renaming imports `as`); research Form A5/F2d"
---

## Rule

An import alias `import a.b.C as D` introduces the entity under the local name `D`,
but the binding target is still the FQN `a.b.C` — `D` is a file-local name, never a
key or an edge target, and the original simple name `C` is NOT introduced. The
extractor records `a.b.C` (the FQN before `as`) and never `D` nor a fabricated
`a.b.D`.

## Files

```kotlin path=src/m/Message.kt
package org.test
class Message
```

```kotlin path=src/c/Use.kt
package com.app
import org.test.Message as TestMessage
class C
```

## Expect

- src/c/Use.kt:2 -> node:m      # the edge target is `org.test.Message` (node m); the alias `TestMessage` is never a key

## Why

Binding the alias `D` as a public name, or treating `as D` as importing a symbol
named `D` from `a.b`, would invent a phantom target. The FQN before `as` is the only
edge target.
