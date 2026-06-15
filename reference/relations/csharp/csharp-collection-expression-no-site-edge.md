---
id: csharp-collection-expression-no-site-edge
language: csharp
category: trap
expectation: edge
cites: "C# 12 — collection expressions; MS Learn — collection expressions"
---

## Rule

A collection expression `[a, b, ..rest]` (C# 12) has NO type token; its type is
target-typed from the assignment / parameter (`List<Foo> xs = [a, b];`). The element
/ collection type reference is carried by the TARGET type `List<Foo>` (whose
argument `Foo` is a real reference), not by the `[ … ]` literal, whose elements are
expressions. No type may be bound at the literal site.

## Files

```csharp path=src/c/Use.cs
using N;
using System.Collections.Generic;
class C { void M(Foo a, Foo b) { List<Foo> xs = [a, b]; } }
```

```csharp path=src/n/Foo.cs
namespace N;
public class Foo {}
```

## Expect

- src/c/Use.cs:3 -> node:n      # the edge is carried by the target type List<Foo>, not the [a, b] literal (node n)

## Why

A collection-expression literal carries no type token; reading any element
identifier as a type would be a false positive. The edge is the target type.
