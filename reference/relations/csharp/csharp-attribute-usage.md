---
id: csharp-attribute-usage
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §22 (attributes; FooAttribute naming convention); MS Learn — attributes"
---

## Rule

An attribute application `[Foo]` is a type reference to an attribute class. By the
`Foo` → `FooAttribute` naming convention, the bare attribute name resolves to the
declared `FooAttribute` type. Under `using N;`, both candidates (`N.Foo` and
`N.FooAttribute`) are produced, so `[Foo]` is a real dependency on the node
declaring the attribute type.

## Files

```csharp path=src/c/Use.cs
using N;
[Foo]
class C { }
```

```csharp path=src/n/Foo.cs
namespace N;
public class FooAttribute : System.Attribute {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # `[Foo]` binds N.FooAttribute (node n) via the attribute naming convention

## Why

Attribute type dependencies (and the implicit `Attribute` suffix convention)
would otherwise be entirely missed.
