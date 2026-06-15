---
id: csharp-using-static-no-namespace-prefix
language: csharp
category: import
expectation: silence
cites: "C# spec §13.4 (using_static_directive); MS Learn — using static directive"
---

## Rule

A `using static N.C;` directive imports the accessible static MEMBERS of the type `N.C`
into the file — it does NOT import the namespace `N`. So an unqualified base name `Baz`
must NOT acquire an `N.Baz` candidate from a static-using: the static using brings
members of `C`, not sibling types of the namespace. Here the bare `Baz` has only its
verbatim candidate, which is not declared in any node, so no `N.Baz` sibling edge is
emitted. (The static-using TARGET `N.C` is a separate dependency form, covered by
`csharp-using-static-target-edge`; in THIS case the target `Ext.Calc` is external /
unmapped, so it too binds nothing — keeping the case a pure assertion that the
namespace-prefix expansion never happens.)

## Files

```csharp path=src/c/Use.cs
using static Ext.Calc;
class D : Baz { }
```

```csharp path=src/n/Baz.cs
namespace Ext;
public class Baz { }
```

## Expect

- silence      # `using static Ext.Calc;` adds no `Ext.Baz` candidate; bare `Baz` binds nothing (and the external target `Ext.Calc` binds nothing)

## Why

Proves the resolver does not over-expand a static-using into a namespace import —
which would invent an `Ext.Baz` edge the language never permits. Zero false positive.
