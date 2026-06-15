---
id: kotlin-enum-member-import-verbatim-silence
language: kotlin
category: import
expectation: silence
cites: "Kotlin docs — Packages and imports (enum constants importable); research Form A7/F2e (verbatim FQN)"
---

## Rule

An enum-constant import `import a.b.Color.RED` emits the import's verbatim dotted FQN
(`com.acme.model.Color.RED`) — the extractor does NOT pre-drop the trailing member.
Binding it to a node is the resolver's job, via the guarded `+`-split at a
declared-type boundary. With no in-graph declaration of `com.acme.model.Color` (nor a
top-level `com.acme.model.Color.RED`), the verbatim key and every guarded split find
nothing, so the import resolves to nothing.

## Files

```kotlin path=src/c/Use.kt
import com.acme.model.Color.RED
class C
```

## Expect

- silence      # the verbatim FQN `com.acme.model.Color.RED` is emitted but no in-graph file declares it → no edge

## Why

The extractor emits the verbatim member FQN unchanged; silencing is the symbol
table's job. With nothing declared, an external/absent enum-member import is a
non-event, never a false positive.
