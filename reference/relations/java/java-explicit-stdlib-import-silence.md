---
id: java-explicit-stdlib-import-silence
language: java
category: builtin
expectation: silence
cites: "JLS SE25 §7.3, §7.5.1; research C1 (C9 in 06-14)"
---

## Rule

Even an explicit `import java.lang.String;` (redundant — `java.lang` is auto-imported)
and framework imports `import javax.annotation.Nullable;` / `import jakarta.inject.Inject;`
resolve to no in-repo `.java` → undefined → silence. Silence is fail-to-find across the
whole `java.*` / `javax.*` / `jakarta.*` surface, not a denylist.

## Files

```java path=src/main/java/com/app/Use.java
package com.app;
import java.lang.String;
import javax.annotation.Nullable;
import jakarta.inject.Inject;
class C {}
```

## Expect

- silence      # none of the java.lang / javax / jakarta imports has an in-repo file → no edge

## Why

Standard-library and framework imports have no source in the repo; they fail to find
and are silenced.
