---
id: csharp-using-alias
language: csharp
category: import
expectation: edge
cites: "C# spec §13.4 (using_alias_directive); MS Learn — using-directive (alias)"
---

## Rule

A `using Alias = Namespace.Type;` directive binds `Alias`, for the remainder of
that file, to that exact type. The alias expansion is the NEAREST candidate for
the short name `Alias`, so a reference to `Alias` (here `new Gw()`) is a real
dependency on the node declaring `Namespace.Type` — never on a coincidental
top-level type sharing the bare alias spelling. No alias chaining: the right-hand
side is fully qualified against the global namespace, not the enclosing one.

## Files

```csharp path=src/c/Use.cs
using Gw = Foo.Bar.IGateway;
namespace App;
class C { void M() { var x = new Gw(); } }
```

```csharp path=src/g/IGateway.cs
namespace Foo.Bar;
public class IGateway { }
```

## Expect

- src/c/Use.cs:3 -> node:g      # `new Gw()` binds the alias target Foo.Bar.IGateway (node g)

## Why

Catches a real type dependency expressed only through a using-alias — the alias
spelling never appears in the depended-on file, so only alias-aware resolution
finds the edge.
