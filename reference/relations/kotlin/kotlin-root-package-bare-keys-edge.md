---
id: kotlin-root-package-bare-keys-edge
language: kotlin
category: import
expectation: edge
cites: "Kotlin spec — Packages and imports (root package = empty FQN); research Form A1/F1 (root package)"
---

## Rule

A file with no `package` header belongs to the root package (empty FQN). Its
top-level declarations key as bare simple names — `class Foo` → `Foo`, `fun bar()`
→ `bar` — never with a leading dot. A root-package import names the bare symbol
(`import Foo`) and binds the declaring file.

## Files

```kotlin path=src/r/Root.kt
class Foo
fun bar() {}
```

```kotlin path=src/c/Use.kt
import Foo
class C
```

## Expect

- src/c/Use.kt:1 -> node:r      # `import Foo` binds the root-package bare key `Foo` (node r), no leading dot

## Why

A leading-dot or path-derived key for a root-package declaration would never match
the bare import; bare keying keeps the root package addressable.
