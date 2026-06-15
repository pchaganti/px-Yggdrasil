---
id: csharp-pointer-stackalloc-element
language: csharp
category: usage-site
expectation: edge
cites: "C# — unsafe pointer types §23; stackalloc operator; MS Learn — pointer types, stackalloc"
---

## Rule

A pointer type `Foo*` and a `stackalloc Foo[n]` each reference their ELEMENT type
`Foo`. The `*` / `stackalloc` wrapper is unwrapped to the element identifier, which
is resolved like any type reference. Under `using N;` the bare `Foo` acquires its
`N.Foo` candidate.

## Files

```csharp path=src/c/Use.cs
using N;
class C { unsafe void M() { Foo* p = null; var s = stackalloc Foo[4]; } }
```

```csharp path=src/n/Foo.cs
namespace N;
public struct Foo {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # `Foo*` pointer element binds N.Foo (node n)
- src/c/Use.cs:2 -> node:n      # `stackalloc Foo[4]` element binds N.Foo (node n)

## Why

The element type under a pointer/`stackalloc` wrapper is a real reference; not
unwrapping the wrapper misses the edge.
