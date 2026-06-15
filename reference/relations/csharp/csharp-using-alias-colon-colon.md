---
id: csharp-using-alias-colon-colon
language: csharp
category: import
expectation: edge
cites: "C# spec §13.8 (qualified alias member `::`); §13.4 (using_alias_directive)"
---

## Rule

In `S::Tail`, the left of `::` is resolved ONLY as an alias. When `S` is an in-file
using-alias to a NAMESPACE (`using S = N.Sub;`), `S::Tail` rewrites the leftmost segment
to that namespace and resolves `N.Sub.Tail` from the root. (This is distinct from an
`extern alias`, whose root names an external assembly a source-only tool cannot resolve —
that stays silent.) Here `S` is a confirmed using-namespace alias, so `S::Tail` binds the
node declaring `N.Sub.Tail`.

## Files

```csharp path=src/c/Use.cs
using S = N.Sub;
class C { S::Tail t; }
```

```csharp path=src/n/Tail.cs
namespace N.Sub;
public class Tail { }
```

## Expect

- src/c/Use.cs:2 -> node:n      # `S::Tail` rewrites S→N.Sub and binds N.Sub.Tail (node n)

## Why

The using-alias-to-namespace `::` form resolves to a real type; binding it only when `S`
is a confirmed in-file alias (never an extern/unknown alias root) keeps it zero-FP.
