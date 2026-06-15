---
id: java-single-import-sibling-same-name-trap
language: java
category: trap
expectation: edge
cites: "JLS SE25 §7.5.1 (canonical-name binding); research B1 sibling-same-name trap (C3 in 06-14)"
---

## Rule

When two nodes each declare a type with the SAME simple name in DIFFERENT packages,
a single-type-import binds ONLY the package it actually names.
`import com.acme.payments.Gateway` is the EXACT path `com/acme/payments/Gateway.java`
(node payments), never the sibling `com/vendor/Gateway.java` (node vendor) that
shares the simple name `Gateway`. A different package is a different file:
collisions are impossible by construction because the FQN is the key, never a bare
simple name.

## Files

```java path=src/main/java/com/acme/payments/Gateway.java
package com.acme.payments;
public class Gateway {}
```

```java path=src/main/java/com/vendor/Gateway.java
package com.vendor;
public class Gateway {}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import com.acme.payments.Gateway;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:payments      # binds com.acme.payments.Gateway (node payments), never the sibling com.vendor.Gateway (node vendor)

## Why

The decisive false-positive class: a same-simple-name type in another package must
NOT be chosen over the imported FQN. The exact dotted path rejects it.
