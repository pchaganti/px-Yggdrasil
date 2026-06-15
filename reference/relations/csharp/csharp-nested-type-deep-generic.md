---
id: csharp-nested-type-deep-generic
language: csharp
category: nested
expectation: edge
cites: "C# spec §7.8.1 (trailing dotted repetitions); §14.8 (nested types); MS Learn — nested types"
---

## Rule

A nested type's reflection key splits each `.I` after a declared-type prefix onto a
further `+` boundary: `App.Outer.Mid.Inner` keys as `App.Outer+Mid+Inner` (deeper
than the single-level `Outer.Inner` split). A generic nested form `Outer<T>.Inner`
keys on the inner simple names; the type arguments inside are descended as separate
references. A nested chain is never read as namespaces.

## Files

```csharp path=src/c/Use.cs
namespace App;
class C { Outer.Mid.Inner f; }
```

```csharp path=src/o/Outer.cs
namespace App;
public class Outer { public class Mid { public class Inner {} } }
```

## Expect

- src/c/Use.cs:2 -> node:o      # `Outer.Mid.Inner` keys App.Outer+Mid+Inner (node o)

## Why

Deep nested chains are a common type-reference shape; splitting only one level would
miss the edge, and reading the chain as namespaces would mis-resolve it.
