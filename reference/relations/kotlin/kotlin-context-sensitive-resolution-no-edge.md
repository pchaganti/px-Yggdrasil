---
id: kotlin-context-sensitive-resolution-no-edge
language: kotlin
category: usage-site
expectation: silence
cites: "What's new in Kotlin 2.2.0 — context-sensitive resolution; What's new in Kotlin 2.3.0 — improvements; KEEP-0379; research Form E6"
---

## Rule

Context-sensitive resolution (Kotlin 2.2 preview, improved 2.3) lets you omit the type
name where the expected type is known — e.g. `when (problem) { CONNECTION -> … }`
instead of `Problem.CONNECTION`. The bare omitted entry `CONNECTION` resolves against
the already-known expected type at the site; it introduces NO new top-level reference.
A source-only tool must NOT read the bare entry as a top-level type reference. Even
with a same-named top-level type in-graph (here `com.acme.other.CONNECTION`), the bare
entry must produce no edge.

## Files

```kotlin path=src/model/Problem.kt
package com.acme.model
enum class Problem {
  CONNECTION, AUTHENTICATION
}
```

```kotlin path=src/other/CONNECTION.kt
package com.acme.other
class CONNECTION
```

```kotlin path=src/c/Use.kt
package com.acme.app
fun handle(problem: com.acme.model.Problem) = when (problem) {
  CONNECTION -> 1
  else -> 0
}
```

## Expect

- silence      # the bare omitted enum entry `CONNECTION` is resolved against the expected type, never read as a top-level reference → no edge (and the expected type `Problem` is itself a usage-site ref, also silenced)

## Why

Reading the bare entry as a same-named top-level type elsewhere would be a false
positive; the feature only removes a qualifier and never introduces a new bindable
top-level name.
