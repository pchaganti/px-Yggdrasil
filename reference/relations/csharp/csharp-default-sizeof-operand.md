---
id: csharp-default-sizeof-operand
language: csharp
category: usage-site
expectation: edge
cites: "C# — default operator, sizeof operator; MS Learn — default(T), sizeof"
---

## Rule

The type operand of `default(X)` (typed default) and of `sizeof(X)` (unmanaged `X`)
is a real type reference, resolved like any other operand. Under `using N;`, the
bare `X` acquires its `N.X` candidate. A bare `default` literal (no parentheses)
carries no type and is silent.

## Files

```csharp path=src/c/Use.cs
using N;
class C { void M() { var d = default(X); var s = sizeof(Y); } }
```

```csharp path=src/n/Types.cs
namespace N;
public struct X {}
public struct Y {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # `default(X)` operand binds N.X (node n)
- src/c/Use.cs:2 -> node:n      # `sizeof(Y)` operand binds N.Y (node n)

## Why

`default(X)` and `sizeof(X)` take genuine type operands; missing them under-detects
real dependencies.
