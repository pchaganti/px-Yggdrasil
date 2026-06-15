---
id: java-static-on-demand-no-phantom-package-dir
language: java
category: trap
expectation: silence
cites: "JLS SE25 §7.5.4; research B4 no-phantom-package-dir (C7 in 06-14)"
---

## Rule

If `com.acme.util.Constants` happened to be a DIRECTORY (a package) holding `.java`
files, a static-on-demand TYPE hint must still resolve to nothing — there is no
`Constants.java` type file. `resolveJavaFqn` does NO package fall-through: a TYPE hint
whose FQN is actually a directory resolves to undefined → silence, never a
representative member of the directory.

## Files

```java path=src/main/java/com/acme/util/Constants/A.java
package com.acme.util.Constants;
public class A {}
```

```java path=src/main/java/com/acme/util/Constants/B.java
package com.acme.util.Constants;
public class B {}
```

```java path=src/main/java/com/app/Use.java
package com.app;
import static com.acme.util.Constants.*;
class C {}
```

## Expect

- silence      # com.acme.util.Constants is a directory, not a type file → no Constants.java → undefined → no edge

## Why

A type FQN that maps to a directory is never coerced into a package edge; only the
wildcard (package) branch reads a directory, and a static-on-demand is on the type axis.
