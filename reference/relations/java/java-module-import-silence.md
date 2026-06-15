---
id: java-module-import-silence
language: java
category: import
expectation: silence
cites: "JEP 511 Module Import Declarations (Java 25); JLS SE25 §7.5.5; research B5 (NEW vs 06-14)"
---

## Rule

A module import declaration `import module M;` (JEP 511, final in Java 25) imports, on
demand, all public top-level types of every package exported by module `M` (and its
`requires transitive` closure). The operand is a MODULE name — not a type FQN, not a
package directory. The set of simple names it brings lives in compiled module-path
metadata (`java.base`'s jmods; a third-party JAR) a hermetic source-only tool never
reads, and a module exports many packages from many directories, so there is no single
path to map. The extractor recognizes the `module` soft keyword and emits NO hint, so a
directory coincidentally named like a module segment can never be matched. (In the
pre-JEP-511 grammar `import module M;` parses malformed and would otherwise leave a
whitespace-bearing pseudo-FQN; a whitespace-validity backstop drops that too.)

## Files

```java path=src/main/java/com/acme/lib/X.java
package com.acme.lib;
public class X {}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import module java.base;
import module com.acme.lib;
class C {}
```

## Expect

- silence      # `import module …` names a module → no type/package path → no edge, even though com.acme.lib/X.java is in-graph

## Why

A module name has no single file or directory to bind; resolving it would require
module-graph reconstruction from metadata a source-only tool never has.
