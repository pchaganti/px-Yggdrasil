---
id: csharp-using-alias-to-namespace
language: csharp
category: import
expectation: edge
cites: "C# spec §13.4 (using_alias_directive, namespace alias); MS Learn — using-alias for a namespace"
---

## Rule

A `using Al = N.Sub;` directive aliases the NAMESPACE `N.Sub`. A later dotted
reference `Al.Type` rewrites its leftmost segment through the alias, so it expands
to `N.Sub.Type` and the dotted tail follows the alias target. That alias-expanded
form is the nearest candidate, so `Al.Type` is a real dependency on the node
declaring `N.Sub.Type`.

## Files

```csharp path=src/c/Use.cs
using Al = N.Sub;
namespace App;
class C : Al.Type { }
```

```csharp path=src/n/Type.cs
namespace N.Sub;
public class Type {}
```

## Expect

- src/c/Use.cs:3 -> node:n      # `Al.Type` expands the namespace alias to N.Sub.Type (node n)

## Why

Catches a dependency whose namespace prefix is spelled only as an alias — without
alias-aware rewriting of the leftmost segment, the edge is invisible.
