---
id: java-single-type-import-edge
language: java
category: import
expectation: edge
cites: "JLS SE25 §7.5.1 single-type-import; research B1 (C3 in 06-14)"
---

## Rule

A single-type-import `import a.b.C;` imports one named type by its canonical name
(JLS §7.5.1). The Java extractor emits the TYPE FQN `a.b.C` as a `path` hint; the
resolver maps it to a `.java` file by the package = directory convention
(`resolveJavaFqn` → `a/b/C.java`, searched at the importing file's directory and
every ancestor up to the repo root, nearest-first, fail-to-silence on a miss). The
import IS the per-type edge: `import com.acme.payments.PaymentService` is a real
dependency on the file declaring that exact FQN, keyed off the fully-qualified
import STRING and an exact file path — never a bare simple name.

## Files

```java path=src/main/java/com/acme/payments/PaymentService.java
package com.acme.payments;
public class PaymentService {}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import com.acme.payments.PaymentService;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:payments      # the import binds com/acme/payments/PaymentService.java (node payments)

## Why

The fully-qualified import string maps to exactly one file path by construction;
a different package is a different file, so there is nothing to mis-bind.
