---
id: csharp-alias-closed-generic
language: csharp
category: import
expectation: edge
cites: "C# 12 — using alias to any type (closed generic); MS Learn — using-alias directive (C# 12 enhancements)"
---

## Rule

A C# 12 alias to a closed generic `using L = ...List<MyApp.Models.Customer>;`
introduces the embedded named types as real dependencies: `MyApp.Models.Customer`
is referenced through the alias even though the alias name `L` never appears in the
depended-on file. The alias name itself binds nothing spurious. So a use of `L`
carries a real dependency on the node declaring the embedded type argument.

## Files

```csharp path=src/c/Use.cs
using L = System.Collections.Generic.List<MyApp.Models.Customer>;
namespace App;
class C { L _x; }
```

```csharp path=src/m/Customer.cs
namespace MyApp.Models;
public class Customer {}
```

## Expect

- src/c/Use.cs:1 -> node:m      # the closed-generic alias RHS embeds MyApp.Models.Customer (node m)

## Why

The dependency is buried inside a generic type argument on the right-hand side of
an alias — only descending the alias RHS for its embedded named types finds it.
