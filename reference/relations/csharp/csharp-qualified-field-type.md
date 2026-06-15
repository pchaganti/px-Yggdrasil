---
id: csharp-qualified-field-type
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §15.5 (fields); §7.8 (qualified name lookup); MS Learn — fields"
---

## Rule

A qualified name `Foo.Bar.Dep` appearing as a field type is walked like any other
qualified reference — detection is not limited to base lists and object creation.
So a field declared `Foo.Bar.Dep _d;` is a real dependency on the node declaring
`Foo.Bar.Dep`.

## Files

```csharp path=src/c/Use.cs
namespace App;
class C { Foo.Bar.Dep _d; }
```

```csharp path=src/d/Dep.cs
namespace Foo.Bar;
public class Dep {}
```

## Expect

- src/c/Use.cs:2 -> node:d      # qualified field type `Foo.Bar.Dep` binds (node d)

## Why

A real dependency may be expressed only as a member type; the qualified-name pass
must reach field positions, not only base/new.
