---
id: kotlin-explicit-stdlib-import-absent-silence
language: kotlin
category: builtin
expectation: silence
cites: "Kotlin spec — Packages and imports (stdlib/external FQN absent); research Form B1/F3 (explicit stdlib import)"
---

## Rule

An explicit `import kotlin.collections.List` (or `import java.util.ArrayList`) IS
emitted by the extractor — silencing is the SymbolTable's job. No in-graph file
declares `kotlin.collections.List` or `java.util.ArrayList`, so the FQN is absent →
silence. No false positive.

## Files

```kotlin path=src/c/Use.kt
import kotlin.collections.List
import java.util.ArrayList
class C
```

## Expect

- silence      # the imports are emitted but no in-graph file declares these stdlib/platform FQNs → absent → no edge

## Why

External and stdlib FQNs resolve to no in-graph definition and are never flagged; the
extractor need not special-case them, the resolver's absence handles it.
