---
id: csharp-generic-type-argument
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §8.4 (constructed types, type arguments); MS Learn — generic type arguments"
---

## Rule

A type argument inside a generic name is itself a type reference: in `List<Foo>`
the argument `Foo` must be walked, not only the generic `List`. Under `using N;`,
the embedded `Foo` acquires the `N.Foo` candidate, so a dependency carried only as
a generic type argument is a real dependency on the node declaring `N.Foo`.

## Files

```csharp path=src/c/Use.cs
using N;
class C { List<Foo> _x; }
```

```csharp path=src/n/Foo.cs
namespace N;
public class Foo {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # generic type argument `Foo` in `List<Foo>` binds N.Foo (node n)

## Why

A dependency carried only inside a type-argument list must be descended into;
otherwise the only edge would be to the container type.
