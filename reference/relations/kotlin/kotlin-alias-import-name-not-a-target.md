---
id: kotlin-alias-import-name-not-a-target
language: kotlin
category: trap
expectation: edge
cites: "Kotlin spec — Packages and imports (alias is a file-local name); research Form A5/F2d (alias not a real name)"
---

## Rule

The alias in `import a.b.C as D` is a file-local name; it is NEVER a symbol key or
edge target. So even if some node happens to declare a type whose simple name equals
the alias (here `org.test.TestMessage`), the aliased import must still bind the FQN
before `as` (`org.test.Message`) and must never reach the alias-named type. The only
edge is the FQN one.

## Files

```kotlin path=src/m/Message.kt
package org.test
class Message
```

```kotlin path=src/t/TestMessage.kt
package org.test
class TestMessage
```

```kotlin path=src/c/Use.kt
package com.app
import org.test.Message as TestMessage
class C
```

## Expect

- src/c/Use.kt:2 -> node:m      # binds `org.test.Message` (node m); the alias `TestMessage` is never a key, so node t is never reached

## Why

If the alias were treated as a real name, the import could mis-bind the unrelated
`org.test.TestMessage`. The alias being file-local-only seals that off — only the
pre-`as` FQN is the target.
