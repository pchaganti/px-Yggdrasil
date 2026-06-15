---
id: java-same-package-no-import-silence
language: java
category: usage-site
expectation: silence
cites: "JLS SE25 §6.3, §7.6 (same-package simple-name visibility); research A2 (C1/C2 in 06-14)"
---

## Rule

A same-package top-level type is referenceable by simple name with NO `import`
(JLS §7.6). `class Child extends Parent { Sibling s; }` references `Parent` and
`Sibling` declared in sibling files of the same package by BARE SIMPLE NAME — not as a
fully-qualified `scoped_type_identifier`. Unlike a fully-qualified inline type reference
(which now edges because the FQN is shadow-free per §6.5.5.2), a bare simple name carries
no shadow-free hint, so the extractor emits nothing. A same-node reference is benign
(intra-node, not a relation); a cross-node split package is a REAL tolerated
false-NEGATIVE. Adding bare-simple-name resolution to catch it would reintroduce the
§6.5.5 precedence trap and is FORBIDDEN.

## Files

```java path=src/main/java/com/a/Parent.java
package com.a;
public class Parent {}
```

```java path=src/main/java/com/a/Sibling.java
package com.a;
public class Sibling {}
```

```java path=src/main/java/com/a/Child.java
package com.a;
class Child extends Parent {
  Sibling s;
}
```

## Expect

- silence      # same-package simple-name refs carry no import → no hint, even though Parent/Sibling are in-graph

## Why

Resolving a bare same-package simple name would hit the §6.5.5 precedence trap; the
missed edge is the tolerated price of zero false positives.
