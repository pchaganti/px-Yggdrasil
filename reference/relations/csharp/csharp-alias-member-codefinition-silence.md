---
id: csharp-alias-member-codefinition-silence
language: csharp
category: trap
expectation: silence
cites: "C# CS0104-class co-definition (using-alias name competes with an enclosing member of the same name); MS Learn — using-alias directive"
---

## Rule

When a using-alias `I` is in scope AND the enclosing namespace also declares a
member named `I`, the simple name `I` is ambiguous (a co-definition between the
alias and the enclosing member). The resolver must SILENCE rather than bind the
alias target unconditionally — both meanings exist, so committing to either would
be a false positive.

## Files

```csharp path=src/c/Use.cs
using I = N.Thing;
namespace App;
class C : I { }
```

```csharp path=src/n/Thing.cs
namespace N;
public class Thing {}
```

```csharp path=src/app/I.cs
namespace App;
public class I {}
```

## Expect

- silence      # alias `I` (→ N.Thing) co-defined with enclosing member `App.I` → ambiguous → no edge

## Why

An alias name colliding with a same-named enclosing member is ambiguous; binding
the alias target alone would ignore the competing member and risk the wrong edge.
Silence preserves zero false positives.
