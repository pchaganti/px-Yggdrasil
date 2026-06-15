---
id: csharp-target-typed-new-no-site-edge
language: csharp
category: trap
expectation: edge
cites: "C# 9 — target-typed new; MS Learn — new operator (target-typed new)"
---

## Rule

A target-typed `new()` (C# 9) has NO type token at the construction site — its type
comes from the assignment / parameter / return target. So `Foo f = new();` carries
its edge through the DECLARED type `Foo` (the field/var type), never through the
empty `new()`. The `new()` itself must produce no spurious site reference.

## Files

```csharp path=src/c/Use.cs
using N;
class C { void M() { Foo f = new(); } }
```

```csharp path=src/n/Foo.cs
namespace N;
public class Foo {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # the edge is carried by the declared type Foo, not the bare new() (node n)

## Why

The target-typed `new()` carries no type; the only reference is the declared target
type. Mistaking `new()` for a reference would invent a binding that does not exist.
