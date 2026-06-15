---
id: csharp-generic-attribute
language: csharp
category: usage-site
expectation: edge
cites: "C# 11 — generic attributes; MS Learn — generic attributes; Attributes spec §22"
---

## Rule

A C# 11 generic attribute application `[Cache<Bar>]` carries TWO references: the
attribute class itself (`Cache` / `CacheAttribute` via the `Attribute` suffix
convention) AND the type argument `Bar`, which is a real type reference in its own
right. The attribute base name resolves the attribute class; the type argument is
descended separately. Here the type argument `Bar` is the in-graph dependency.

## Files

```csharp path=src/c/Use.cs
using N;
[Cache<Bar>]
class C { }
```

```csharp path=src/n/Bar.cs
namespace N;
public class Bar { }
```

```csharp path=src/a/CacheAttribute.cs
namespace N;
public class CacheAttribute<T> : System.Attribute { }
```

## Expect

- src/c/Use.cs:2 -> node:n      # the generic-attribute type argument `Bar` binds N.Bar (node n)
- src/c/Use.cs:2 -> node:a      # the attribute name `Cache` binds N.CacheAttribute (node a) via the suffix convention

## Why

Without descending the generic-attribute type argument, the `Bar` dependency is missed
entirely; without the `Attribute` suffix convention on a `generic_name` attribute name,
the attribute-class dependency is missed too.
