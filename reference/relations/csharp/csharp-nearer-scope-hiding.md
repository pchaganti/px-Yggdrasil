---
id: csharp-nearer-scope-hiding
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §7.8.1 (name hiding through nesting / scopes); MS Learn — name lookup, nearer scope wins"
---

## Rule

When `using Ext;` imports a `Repo` AND the enclosing namespace `App` also declares
`App.Repo`, the simple name `Repo` binds the NEARER enclosing-namespace type, never
the farther using-imported one. The enclosing-namespace candidate is ordered ahead
of the using-prefix candidate, so `Repo` is a real dependency on the local node
(declaring `App.Repo`), not the foreign node (declaring `Ext.Repo`).

## Files

```csharp path=src/c/Use.cs
using Ext;
namespace App;
class C : Repo { }
```

```csharp path=src/local/Repo.cs
namespace App;
public class Repo {}
```

```csharp path=src/ext/Repo.cs
namespace Ext;
public class Repo {}
```

## Expect

- src/c/Use.cs:3 -> node:local      # `Repo` binds the nearer enclosing App.Repo (node local), not the imported Ext.Repo (node ext)

## Why

A nearer same-named member hides an imported one; binding the foreign import would
be the wrong edge.
