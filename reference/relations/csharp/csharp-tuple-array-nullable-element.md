---
id: csharp-tuple-array-nullable-element
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §8.3 (nullable types), §8.7 (array types), §8.8 (tuple types); MS Learn — tuple/array/nullable types"
---

## Rule

The element types wrapped by a tuple `(Foo, Bar)`, an array `Baz[]`, and a nullable
`Qux?` are each type references — the walk must reach the identifier each wrapper
encloses. Under `using N;`, each element type (`Foo`, `Bar`, `Baz`, `Qux`)
acquires its `N.` candidate, so each is a real dependency on the node declaring it.

## Files

```csharp path=src/c/Use.cs
using N;
class C { (Foo, Bar) _t; Baz[] _a; Qux? _n; }
```

```csharp path=src/n/Types.cs
namespace N;
public class Foo {}
public class Bar {}
public class Baz {}
public struct Qux {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # tuple element `Foo` binds N.Foo (node n)
- src/c/Use.cs:2 -> node:n      # tuple element `Bar` binds N.Bar (node n)
- src/c/Use.cs:2 -> node:n      # array element `Baz` binds N.Baz (node n)
- src/c/Use.cs:2 -> node:n      # nullable element `Qux` binds N.Qux (node n)

## Why

Element types wrapped by tuple/array/nullable constructors are real dependencies
the walk must unwrap to.
