---
id: csharp-global-using-static-target-edge
language: csharp
category: import
expectation: edge
cites: "C# 10 — global using static (§13.4, project-wide scope); MS Learn — global using directives"
---

## Rule

A `global using static N.C;` is the project-wide form of using-static: it imports the
static members of `N.C` program-wide. Like the plain form it never imports namespace `N`
(no sibling expansion), but the TARGET type `N.C` is a real, fully-qualified type
dependency carried by the file that declares the directive. The target resolves like an
alias RHS (from the root) and binds the node declaring `N.C`.

## Files

```csharp path=src/g/Globals.cs
global using static N.MathHelpers;
```

```csharp path=src/n/MathHelpers.cs
namespace N;
public static class MathHelpers { }
```

## Expect

- src/g/Globals.cs:1 -> node:n      # `global using static N.MathHelpers;` depends on the target type N.MathHelpers (node n)

## Why

The project-wide static-using target is the same genuine dependency as the per-file form,
declared in the file that writes the directive; surfacing it recovers a real edge with no
namespace-sibling over-expansion.
