---
id: csharp-deep-enclosing-chain-walk
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §7.8 / §13.8 (enclosing-namespace member lookup, innermost→outermost); MS Learn — namespace member lookup"
---

## Rule

A partial reference `Models.Order` inside `namespace App.Services.Sub` is resolved
by trying each progressively shorter enclosing namespace, innermost outward:
`App.Services.Sub.Models.Order`, then `App.Services.Models.Order`, then
`App.Models.Order`, then the verbatim `Models.Order`. The first that exists binds
and the walk stops. So when the type lives at `App.Services.Models.Order`, the
reference binds that nearer enclosing form — not a farther or top-level homonym.

## Files

```csharp path=src/c/Use.cs
namespace App.Services.Sub;
class C { void M() { var o = new Models.Order(); } }
```

```csharp path=src/m/Order.cs
namespace App.Services.Models;
public class Order {}
```

## Expect

- src/c/Use.cs:2 -> node:m      # `Models.Order` binds the nearer enclosing App.Services.Models.Order (node m)

## Why

The enclosing-chain walk must emit candidates innermost→outermost so the nearest
binding wins; a deep chain proves more than the one-level case.
