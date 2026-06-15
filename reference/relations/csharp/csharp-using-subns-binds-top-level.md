---
id: csharp-using-subns-binds-top-level
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §13.4 (using imports types of EXACTLY N, not nested namespaces); MS Learn — using-directive scope"
---

## Rule

`using A;` imports the types of EXACTLY namespace `A`, NOT its nested namespace
`A.B`. So a partial reference `B.Type` must NOT bind a hypothetical `A.B.Type`
merely because `A` is imported. When only a real top-level `B.Type` exists, the
reference binds that — the spurious `A.B.Type` candidate matches nothing. So
`B.Type` is a real dependency on the node declaring the top-level `B.Type`.

## Files

```csharp path=src/c/Use.cs
using A;
namespace App;
class C : B.Type { }
```

```csharp path=src/b/Type.cs
namespace B;
public class Type {}
```

## Expect

- src/c/Use.cs:3 -> node:b      # `B.Type` binds the real top-level B.Type (node b); the using-relative A.B.Type matches nothing

## Why

A `using` does not pull in a namespace's nested namespaces; the partial name must
fall through to the real top-level type, never an invented sub-namespace form.
