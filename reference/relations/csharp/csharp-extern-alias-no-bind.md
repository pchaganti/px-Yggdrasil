---
id: csharp-extern-alias-no-bind
language: csharp
category: trap
expectation: silence
cites: "C# spec §13.3 (extern_alias_directive), §7.8 (alias-qualified name `::`); MS Learn — extern alias"
---

## Rule

In an alias-qualified name `Lib::A.B.Base`, the segment left of `::` is an
extern/using alias, never a type or namespace. The alias names a separate assembly
root that a source-only tool cannot resolve, so the reference must NOT bind to a
coincidental same-tail type `A.B.Base` in another node. No cross-node edge may be
emitted.

## Files

```csharp path=src/c/Use.cs
extern alias Lib;
class C : Lib::A.B.Base { }
```

```csharp path=src/x/Base.cs
namespace A.B;
public class Base {}
```

## Expect

- silence      # `Lib::A.B.Base` is alias-qualified into another assembly; the same-tail A.B.Base must NOT bind

## Why

Binding the alias-qualified reference to a same-named local type would be a false
positive — the alias deliberately points at a different assembly root.
