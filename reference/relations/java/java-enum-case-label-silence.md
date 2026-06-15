---
id: java-enum-case-label-silence
language: java
category: trap
expectation: silence
cites: "JLS SE25 §14.11.1, §8.9 (enum constant in switch); research G1 (C37 in 06-14)"
---

## Rule

An unqualified enum constant in a `switch` `case` is resolved against the switch
selector's enum type, NOT as a package/type name (JLS §14.11.1). `case RED:` is a
constant, not a type reference. There is no import, and the import-only extractor emits
nothing; a name-based analyzer that treated `RED` as a candidate type/package would
mis-resolve — this MUST be excluded.

## Files

```java path=src/main/java/com/app/C.java
package com.app;
class C {
  enum Color { RED, GREEN }
  int m(Color c) {
    switch (c) { case RED: return 1; case GREEN: return 2; default: return 0; }
  }
}
```

## Expect

- silence      # enum case labels are constants of the selector type, never type/package names

## Why

Reading an enum case label as a type would be a phantom; it is a must-exclude token.
