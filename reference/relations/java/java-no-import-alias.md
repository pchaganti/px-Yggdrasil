---
id: java-no-import-alias
language: java
category: import
expectation: edge
cites: "JLS SE25 §7.5 (no alias production); research B6 (C12 in 06-14)"
---

## Rule

Java has NO `import a.B as C;` — the §7.5 grammar has no alias production in any of the
import forms (unlike Kotlin `import a.B as C`, C# `using C = a.B`). The imported simple
name is ALWAYS the FQN's last segment, and the FQN string is a complete, rename-free
key. The extractor reads only the scoped_identifier FQN; there is no alias token to
track. A plain import emits exactly its FQN and binds it directly.

## Files

```java path=src/main/java/com/acme/payments/Gateway.java
package com.acme.payments;
public class Gateway {}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import com.acme.payments.Gateway;
class C {}
```

## Expect

- src/main/java/com/app/Use.java:2 -> node:payments      # the FQN itself is the key; there is no alias to remap

## Why

Guards against a future copy-paste from the Kotlin/C# extractor wrongly introducing
alias handling — the Java FQN is always its own complete key.
