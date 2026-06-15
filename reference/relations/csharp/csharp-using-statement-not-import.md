---
id: csharp-using-statement-not-import
language: csharp
category: trap
expectation: edge
cites: "C# — using statement (IDisposable) vs using directive; MS Learn — using statement"
---

## Rule

A `using` STATEMENT — `using (var x = …)`, `using var x = …;`, or `using T t = …;`
— is a resource-management statement inside a method body, NOT an import directive.
It introduces no namespace import and must never be added to the file's import
table. The declared variable's TYPE, however, is a normal local-variable type
reference. Here the local type `Resource` (under `using N;`) is a real dependency,
while the `using` keyword on it imports nothing.

## Files

```csharp path=src/c/Use.cs
using N;
class C { void M() { using Resource r = Acquire(); } Resource Acquire() => null; }
```

```csharp path=src/n/Resource.cs
namespace N;
public class Resource : System.IDisposable { public void Dispose() {} }
```

## Expect

- src/c/Use.cs:2 -> node:n      # local type `Resource` in a using-statement binds N.Resource (node n)

## Why

The using-statement keyword must not be parsed as an import (which would fabricate a
spurious namespace import), yet the declared variable's type is a genuine reference.
