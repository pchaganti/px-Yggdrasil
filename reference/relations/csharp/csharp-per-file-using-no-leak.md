---
id: csharp-per-file-using-no-leak
language: csharp
category: import
expectation: silence
cites: "C# spec §13.4 (using directives are per compilation unit / file scope); MS Learn — using-directive scope"
---

## Rule

A `using A;` declared in one file does NOT propagate to another file — usings are
per compilation unit. So a bare base `Base` in a file that has no `using A;` has
ONLY its verbatim candidate `Base`; it must NOT acquire an `A.Base` candidate from
a sibling file's import. With only `A.Base` declared (and no top-level `Base`), the
reference resolves to nothing — no cross-node edge.

## Files

```csharp path=src/b/B.cs
class C : Base { }
```

```csharp path=src/base/Base.cs
namespace A;
public class Base {}
```

## Expect

- silence      # this file has no `using A;`, so bare `Base` does not bind A.Base — no cross-file leakage

## Why

Cross-file using leakage would be a false positive; per-file scope must be
honored so an import in one file never qualifies a name in another.
