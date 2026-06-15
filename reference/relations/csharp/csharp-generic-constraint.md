---
id: csharp-generic-constraint
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §15.2.5 (type parameter constraints); MS Learn — where (generic type constraint)"
---

## Rule

A type-parameter constraint `where T : Constraint` names a constraint type — a
real type reference. Under `using N;`, the bare `Constraint` acquires the
`N.Constraint` candidate, so the constraint is a real dependency on the node
declaring `N.Constraint`.

## Files

```csharp path=src/c/Use.cs
using N;
class C<T> where T : Constraint { }
```

```csharp path=src/n/Constraint.cs
namespace N;
public class Constraint {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # constraint type `Constraint` binds N.Constraint (node n)

## Why

A constraint type is a real dependency that appears nowhere else in the signature.
