---
id: kotlin-context-parameter-type-silent
language: kotlin
category: usage-site
expectation: silence
cites: "What's new in Kotlin 2.4.0 — Stable context parameters; What's new in Kotlin 2.2.0 — context parameters preview; research Form E5"
---

## Rule

A context parameter `context(repo: com.acme.data.OrderRepo)` (Stable in Kotlin 2.4)
declares a new declaration-HEADER position carrying a type reference. Although that
type is in a TYPE position — which would normally edge as a shadow-free inline FQN —
the shipped tree-sitter-kotlin grammar predates Kotlin 2.2 context parameters, so the
`context(...)` clause parses as an ERROR node. The type reference is invisible to a
source-only tool, so the extractor emits nothing for it — a tolerated recall gap from
the grammar limitation, never a false positive. The type would edge if it were instead
written in a grammar-recognized type position (e.g. a parameter or property type).

## Files

```kotlin path=src/data/OrderRepo.kt
package com.acme.data
class OrderRepo
```

```kotlin path=src/c/Use.kt
package com.acme.app
context(repo: com.acme.data.OrderRepo)
fun save() {}
```

## Expect

- silence      # the `context(...)` clause parses as a grammar ERROR node (shipped grammar predates Kotlin 2.2 context params) → the type ref is invisible → silent

## Why

The context-parameter type sits in a TYPE position that would otherwise edge as a
shadow-free inline FQN, but the shipped tree-sitter-kotlin grammar does not recognize
the `context(...)` clause — it parses as an ERROR node, so the type reference is
invisible to a source-only tool. The silence is a grammar-limitation recall gap, not an
FP risk. Documenting it pins the new 2.4 header position so a future grammar upgrade
that exposes it is wired to edge like any other type-position FQN.
