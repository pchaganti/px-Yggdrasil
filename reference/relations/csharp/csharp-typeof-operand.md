---
id: csharp-typeof-operand
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §12.8.18 (typeof_expression); MS Learn — typeof operator"
---

## Rule

The operand of a `typeof(X)` expression is a type reference. Under `using N;`, the
bare `X` acquires the `N.X` candidate, so `typeof(X)` is a real dependency on the
node declaring `N.X`.

## Files

```csharp path=src/c/Use.cs
using N;
class C { void M() { var t = typeof(X); } }
```

```csharp path=src/n/X.cs
namespace N;
public class X {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # `typeof(X)` operand binds N.X (node n)

## Why

A `typeof` operand is a genuine compile-time type reference that carries a real
dependency.
