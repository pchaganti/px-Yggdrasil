---
id: csharp-global-using-alias
language: csharp
category: import
expectation: edge
cites: "C# 10 — global using alias (§13.4, project-wide scope); MS Learn — global using directives"
---

## Rule

A `global using X = N.Type;` declares a PROJECT-WIDE alias: the alias `X` is usable in
EVERY file's member declarations, not only the declaring file. The alias RHS is resolved
fully-qualified vs the global namespace (the declaring file's context), so the captured
target FQN is the resolved type. The relation pass aggregates every file's global-using
aliases in a pre-pass and injects them into each file's alias map (below any same-named
file-local alias). So a bare `X` in a non-declaring file binds the node declaring
`N.Type`.

## Files

```csharp path=src/g/Globals.cs
global using Cust = MyApp.Models.Customer;
```

```csharp path=src/c/Use.cs
class C { Cust c; }
```

```csharp path=src/m/Customer.cs
namespace MyApp.Models;
public class Customer { }
```

## Expect

- src/c/Use.cs:1 -> node:m      # bare `Cust` resolves via the project-wide global-using alias to MyApp.Models.Customer (node m)

## Why

A global-using alias is invisible at the point of use in a non-declaring file; only
project-wide aggregation of global-using aliases before resolution finds the edge.
