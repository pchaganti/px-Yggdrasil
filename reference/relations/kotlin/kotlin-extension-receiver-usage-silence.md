---
id: kotlin-extension-receiver-usage-silence
language: kotlin
category: usage-site
expectation: silence
cites: "Kotlin spec — Scopes (extension receiver type); research Form D10 (extension receiver type)"
---

## Rule

An extension-function receiver type (`fun Order.summary()`) is a usage-site type
reference. The import-only extractor emits nothing for it, even with the receiver type
in-graph — a deliberate recall miss, never a false positive.

## Files

```kotlin path=src/m/Order.kt
package com.acme.model
class Order
```

```kotlin path=src/c/Use.kt
package com.acme.app
fun com.acme.model.Order.summary(): String = ""
```

## Expect

- silence      # the extension receiver type is a usage site → import-only emits nothing

## Why

The receiver type sits at a usage site; binding it by simple name would hit the
precedence trap.
