---
id: csharp-alias-anytype-embedded
language: csharp
category: import
expectation: edge
cites: "C# 12 — using alias to any type (tuple/array/pointer/nullable); MS Learn — using-alias directive"
---

## Rule

C# 12 lets a using-alias RHS be ANY type — a tuple `(int, Mod.Customer)`, an array
`Mod.Order[]`, a pointer `Mod.Header*`, a nullable value `Mod.Money?`. Each NAMED type
embedded in the structural RHS is a real reference (the wrapper and any tuple element
labels carry no edge). So an alias whose RHS embeds an in-graph type is a real dependency
on that type's node, surfaced by descending the alias RHS's structural form. Here the
tuple alias embeds `Mod.Customer` and the array alias embeds `Mod.Order`.

## Files

```csharp path=src/c/Use.cs
using Pair = (int Id, Mod.Customer Cust);
using Arr = Mod.Order[];
class C { Pair p; Arr a; }
```

```csharp path=src/m/Customer.cs
namespace Mod;
public class Customer { }
```

```csharp path=src/o/Order.cs
namespace Mod;
public class Order { }
```

## Expect

- src/c/Use.cs:1 -> node:m      # tuple alias RHS embeds Mod.Customer (node m)
- src/c/Use.cs:2 -> node:o      # array alias RHS embeds Mod.Order (node o)

## Why

The dependency is buried inside a tuple element / array element on the right-hand side of
an alias — only descending the structural alias RHS for its embedded named types finds it,
and only the named types (never the wrapper or the tuple labels) carry an edge.
