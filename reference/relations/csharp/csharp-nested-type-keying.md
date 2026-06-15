---
id: csharp-nested-type-keying
language: csharp
category: nested
expectation: edge
cites: "C# spec §7.8.1 (nested types, reflection name with '+'); MS Learn — nested types"
---

## Rule

A nested type referenced as `App.Outer.Inner` (where `Outer` is a type and `Inner`
is nested inside it) keys to the reflection-style declaration `App.Outer+Inner`.
The guarded split only fires at a declared-type boundary: `App.Outer` is a known
type, so the tail `Inner` splits onto a `+` boundary, recovering the nested-type
meaning. So `new App.Outer.Inner()` is a real dependency on the node declaring the
outer type.

## Files

```csharp path=src/a/Nested.cs
namespace App;
class Outer { class Inner { } }
```

```csharp path=src/c/Use.cs
namespace Other;
class C { void M() { var x = new App.Outer.Inner(); } }
```

## Expect

- src/c/Use.cs:2 -> node:a      # `App.Outer.Inner` keys to App.Outer+Inner (node a) via the guarded nested-type split

## Why

Under a type you can only nest a type, never a namespace; splitting at the
declared-type boundary recovers the real nested-type declaration key, and never
splitting at a namespace boundary keeps it sound.
