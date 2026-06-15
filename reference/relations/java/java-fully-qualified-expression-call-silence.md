---
id: java-fully-qualified-expression-call-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §6.5.5.2, §15.12 (qualified method invocation); zero-FP boundary (expression vs type position)"
---

## Rule

A fully-qualified static call written inline with NO import — `com.b.Util.run();` where
`Util` lives in another node — is in EXPRESSION position. The grammar parses it as a
`field_access` / `method_invocation` chain (`com` . `b` . `Util` . `run(...)`), NOT as a
`scoped_type_identifier`. The extractor emits a SYMBOL hint only for a `scoped_type_identifier`,
which occurs solely in TYPE positions, so an expression-position dotted call carries no hint.
This is the zero-FP boundary: the sibling inline fully-qualified TYPE reference (a
`scoped_type_identifier` in a field/param/return/extends/throws/new/cast/generic position) DOES
edge because the FQN is shadow-free, but a dotted access in an expression context stays silent —
distinguishing a leading package prefix from a chained field access on a value would require type
information the parser does not have, so it is deliberately never read as a dependency.

## Files

```java path=src/main/java/com/b/Util.java
package com.b;
public class Util {
  public static void run() {}
}
```

```java path=src/main/java/com/a/X.java
package com.a;
class X {
  void m() {
    com.b.Util.run();
  }
}
```

## Expect

- silence      # the fully-qualified static call is in expression position (field_access/method_invocation chain), never a scoped_type_identifier → no hint, even though com.b.Util is in-graph (node b)

## Why

Only TYPE-position references (the grammar node `scoped_type_identifier`) edge. An
expression-position fully-qualified access parses as a field-access / method-invocation chain and
is the zero-FP boundary: it stays silent because the parser cannot tell a leading package prefix
from a value's field chain without type resolution. The missed edge is the tolerated price of zero
false positives.
