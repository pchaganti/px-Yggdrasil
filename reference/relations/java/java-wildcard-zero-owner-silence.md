---
id: java-wildcard-zero-owner-silence
language: java
category: import
expectation: silence
cites: "JLS SE25 §7.5.2; research B2 (C4 zero-owner in 06-14)"
---

## Rule

A type-import-on-demand over a package whose directory holds NO mapped `.java` file
collapses to zero owners → silence. The wildcard never guesses; an absent package is
fail-to-find, not a phantom.

## Files

```java path=src/main/java/com/app/Use.java
package com.app;
import com.acme.empty.*;
class C {}
```

## Expect

- silence      # com/acme/empty/ has no .java in the repo → 0 owners → no edge

## Why

Fail-to-find is the anti-FP guard: a package with no in-repo file produces no edge.
