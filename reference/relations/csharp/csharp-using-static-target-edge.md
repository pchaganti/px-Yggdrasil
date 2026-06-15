---
id: csharp-using-static-target-edge
language: csharp
category: import
expectation: edge
cites: "C# spec §13.4 (using_static_directive); MS Learn — using static directive"
---

## Rule

A `using static N.C;` directive imports the static MEMBERS of the concrete type `N.C`.
While it does NOT import the namespace `N` (no sibling `N.Baz` candidate is ever
created), the TARGET type `N.C` itself IS a real, fully-qualified type dependency of the
file — the directive textually names that type and pulls in its members. The target is
resolved like an alias RHS (fully-qualified, from the root), so it binds the node
declaring `N.C` when that type is in-graph.

## Files

```csharp path=src/c/Use.cs
using static N.MathHelpers;
class C { }
```

```csharp path=src/n/MathHelpers.cs
namespace N;
public static class MathHelpers { }
```

## Expect

- src/c/Use.cs:1 -> node:n      # `using static N.MathHelpers;` is a real dependency on the target type N.MathHelpers (node n)

## Why

The static-using TARGET is a genuine compile-time dependency previously left unsurfaced;
emitting it (resolved as a fully-qualified name, never a namespace-prefix expansion)
recovers a real edge while staying zero-FP.
