---
id: csharp-object-creation
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §12.8.16 (object_creation_expression); MS Learn — new operator"
---

## Rule

An object-creation expression `new Bare()` is a type reference to `Bare`. Under
`using N;`, the bare name acquires the `N.Bare` candidate, so the construction is a
real dependency on the node declaring `N.Bare`.

## Files

```csharp path=src/c/Use.cs
using N;
class C { void M() { var x = new Bare(); } }
```

```csharp path=src/n/Bare.cs
namespace N;
public class Bare {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # `new Bare()` binds N.Bare (node n)

## Why

Object creation is one of the two original detection sites; a constructed type is
a real dependency.
