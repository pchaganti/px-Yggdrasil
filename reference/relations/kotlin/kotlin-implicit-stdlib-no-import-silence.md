---
id: kotlin-implicit-stdlib-no-import-silence
language: kotlin
category: builtin
expectation: silence
cites: "Kotlin spec — Packages and imports (implicit stdlib imports); research Form B1/F3"
---

## Rule

Stdlib packages (`kotlin.*`, plus platform `java.lang` on JVM) are implicitly imported
into every Kotlin file — `List`, `Pair`, `Result`, `listOf` are usable with NO import
line. An import-only extractor sees no import for them and emits nothing. There is no
key to bind, so a same-named project type can never be mis-bound through an implicit
stdlib usage.

## Files

```kotlin path=src/c/Use.kt
package com.acme
fun f(): List<String> = listOf("a")
val p: Pair<Int, Int> = 1 to 2
fun g(): Result<Int> = Result.success(1)
```

## Expect

- silence      # implicit stdlib names used with no import → no import node → nothing emitted

## Why

Resolving a bare stdlib simple name to an in-graph same-named type is the classic
collision FP; the import-only design structurally avoids it by emitting nothing for
unimported names.
