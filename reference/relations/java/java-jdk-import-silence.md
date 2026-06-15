---
id: java-jdk-import-silence
language: java
category: builtin
expectation: silence
cites: "JLS SE25 §7.3 (automatic java.lang import); research C1 (C9 in 06-14)"
---

## Rule

`import java.util.List;` emits its FQN as a hint, but no `java/util/List.java` exists
in a hermetic source-only repo → `resolveJavaFqn` returns undefined → silence. Silence
is the resolver's job (the extractor still emits the hint); a JDK type has no in-repo
`.java` to bind.

## Files

```java path=src/main/java/com/app/Use.java
package com.app;
import java.util.List;
class C {}
```

## Expect

- silence      # no java/util/List.java in the repo → fail-to-find → no edge

## Why

The JDK is invisible to a source-only tool; an unresolved stdlib import is silenced,
never flagged.
