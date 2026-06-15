---
id: kotlin-nested-plus-key-not-dollar-edge
language: kotlin
category: nested
expectation: edge
cites: "Kotlin docs — Reflection (JVM `$` binary names); research Form C1/F4 (no `$`-confusion)"
---

## Rule

The analyzer's canonical nested key uses the reflection separator `+`, NEVER the JVM
binary `$`. A nested type inside an `object` keys `com.acme.Holder+Item` (a `+`
boundary), not `com.acme.Holder$Item`. A consumer's dotted source import
`import com.acme.Holder.Item` resolves via the guarded `+`-split to that `+` key. No
declaration key ever contains `$`, so a stray `$` (in a string, annotation, or JVM
spelling) can never collide with a `+`-keyed nested type.

## Files

```kotlin path=src/a/Holder.kt
package com.acme
object Holder {
  class Item
}
```

```kotlin path=src/c/Use.kt
package com.x
import com.acme.Holder.Item
class C
```

## Expect

- src/c/Use.kt:2 -> node:a      # `com.acme.Holder.Item` splits to the `+` key `com.acme.Holder+Item` (node a); `$` is never produced or read

## Why

Using `+` (disjoint from both `.` and `$`) keeps nested keys in an isolated string
space, so the JVM `$` binary form can never be confused with a flat identifier or a
package boundary.
