---
id: csharp-base-interface-list
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §15.2.4 (class base specification); MS Learn — base classes and interfaces"
---

## Rule

Every bare type in a base/interface list `class C : Base, IFoo` is a type
reference. Under `using N;`, each acquires its `N.` candidate, so both `Base` and
`IFoo` are real dependencies on the node declaring `N.Base` / `N.IFoo`. (A single
base file declaring both makes one node the target of both references.)

## Files

```csharp path=src/c/Use.cs
using N;
class C : Base, IFoo { }
```

```csharp path=src/n/Types.cs
namespace N;
public class Base {}
public interface IFoo {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # bare base `Base` binds N.Base (node n)
- src/c/Use.cs:2 -> node:n      # bare interface `IFoo` binds N.IFoo (node n)

## Why

Base and interface positions are the canonical type-reference site; both bare
names must be detected and resolved.
