---
id: java-external-library-import-silence
language: java
category: builtin
expectation: silence
cites: "JLS SE25 §7.5.1; research C1 (external lib in 06-14)"
---

## Rule

A third-party `import com.google.common.collect.ImmutableList;` resolves to no in-repo
`.java` (the library is on the classpath, not in source) → undefined → silence. Same
fail-to-find guard as the JDK: any FQN whose file is absent is silenced.

## Files

```java path=src/main/java/com/app/Use.java
package com.app;
import com.google.common.collect.ImmutableList;
class C {}
```

## Expect

- silence      # no com/google/common/collect/ImmutableList.java in the repo → no edge

## Why

External libraries have no source in the repo; their imports fail to find and are silenced.
