---
id: kotlin-stdlib-collision-project-result-silence
language: kotlin
category: trap
expectation: silence
cites: "Kotlin spec — Packages and imports (stdlib collision); research Form B1/F3 (collision trap)"
---

## Rule

A project may declare a type whose simple name collides with an implicit stdlib name
— here `com.acme.util.Result` vs the implicit `kotlin.Result`. A file that uses the
bare `Result` with no import binds (in Kotlin) the implicit `kotlin.Result`. The
import-only extractor emits NOTHING for the bare usage, so the project `Result` can
never be mis-bound. If a future version resolved the bare simple name it would be
ambiguous (project vs stdlib) → must silence; here it is structurally silent.

## Files

```kotlin path=src/u/Result.kt
package com.acme.util
class Result
```

```kotlin path=src/c/Use.kt
package com.acme.app
fun f(): Result<Int> = TODO()
```

## Expect

- silence      # bare `Result` usage with no import → nothing emitted; the project `com.acme.util.Result` is never mis-bound

## Why

The stdlib-collision trap is the single biggest FP source for a bare-name binder;
emitting nothing for the unimported bare name closes it.
