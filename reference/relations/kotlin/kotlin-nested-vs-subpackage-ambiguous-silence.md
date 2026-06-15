---
id: kotlin-nested-vs-subpackage-ambiguous-silence
language: kotlin
category: trap
expectation: silence
cites: "Kotlin docs — Nested and inner classes vs packages; research Form A9/F4 (nested vs sub-package)"
---

## Rule

`import com.acme.Outer.Inner` is genuinely ambiguous between two readings when both
exist: the NESTED type `com.acme.Outer+Inner` (node nest) and a TOP-LEVEL type `Inner`
in the SUB-PACKAGE `com.acme.Outer` keyed `com.acme.Outer.Inner` (node sub). The
verbatim dotted key maps to one file and the `+`-split to a DIFFERENT file → ≥2
distinct files → ambiguous → silence. No arbitrary mis-bind.

## Files

```kotlin path=src/nest/Outer.kt
package com.acme
class Outer {
  class Inner
}
```

```kotlin path=src/sub/Inner.kt
package com.acme.Outer
class Inner
```

```kotlin path=src/c/Use.kt
package com.x
import com.acme.Outer.Inner
class C
```

## Expect

- silence      # verbatim `com.acme.Outer.Inner` (node sub) and the `+`-split `com.acme.Outer+Inner` (node nest) map to two files → ambiguous → no edge

## Why

Two plausible readings resolving to different files is a real ambiguity; silencing
the group rather than coin-flipping keeps zero false positives.
