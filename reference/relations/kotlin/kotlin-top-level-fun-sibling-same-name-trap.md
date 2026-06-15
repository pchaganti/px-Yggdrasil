---
id: kotlin-top-level-fun-sibling-same-name-trap
language: kotlin
category: trap
expectation: edge
cites: "Kotlin docs — Packages and imports (exact FQN binding); research Form A4/F2b (sibling same-name trap)"
---

## Rule

Two packages may each define a top-level function with the same simple name. An
import binds only the package it names: `import a.log` binds `a.log`, never the
same-named `b.log`. The exact dotted FQN is the binding axis; the simple name `log`
is never the key.

## Files

```kotlin path=src/a/util.kt
package a
fun log() {}
```

```kotlin path=src/b/util.kt
package b
fun log() {}
```

```kotlin path=src/c/Use.kt
package c
import a.log
class C
```

## Expect

- src/c/Use.kt:2 -> node:a      # `import a.log` binds `a.log` (node a), never the same-named `b.log` (node b)

## Why

Two top-level functions sharing a simple name in different packages is the top-level
analogue of the type same-name trap; the exact FQN rejects the sibling.
