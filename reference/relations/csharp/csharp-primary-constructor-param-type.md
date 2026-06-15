---
id: csharp-primary-constructor-param-type
language: csharp
category: usage-site
expectation: edge
cites: "C# 12 — primary constructors; MS Learn — primary constructors tutorial"
---

## Rule

A C# 12 primary constructor declares parameters on the type-declaration header:
`class C(IDep dep) { … }`. The parameter TYPES (`IDep`) are real type references,
resolved like any parameter type; the parameter NAME (`dep`) is not. Under
`using N;` the bare `IDep` acquires its `N.IDep` candidate.

## Files

```csharp path=src/c/Use.cs
using N;
namespace App;
class C(IDep dep) {}
```

```csharp path=src/n/IDep.cs
namespace N;
public interface IDep {}
```

## Expect

- src/c/Use.cs:3 -> node:n      # primary-constructor parameter type `IDep` binds N.IDep (node n)

## Why

Primary-constructor parameter types sit on the type-declaration header — a position
a base/member-only walker skips — and commonly carry dependency-injection deps.
