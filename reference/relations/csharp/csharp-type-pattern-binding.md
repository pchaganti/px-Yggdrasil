---
id: csharp-type-pattern-binding
language: csharp
category: usage-site
expectation: edge
cites: "C# — pattern matching (declaration/type patterns); MS Learn — patterns"
---

## Rule

A declaration / type pattern names a type: `x is X y`, `case X x:`, and a property
pattern `{ Prop: SubType s }` each reference the type (`X`, `SubType`). The binding
identifier (`y`, `x`, `s`) and `var` / constant patterns reference no type. Under
`using N;` the pattern type acquires its `N.` candidate.

## Files

```csharp path=src/c/Use.cs
using N;
class C { void M(object o) { if (o is X x) {} } }
```

```csharp path=src/n/X.cs
namespace N;
public class X {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # type pattern `is X x` binds N.X (node n)

## Why

The type in a declaration pattern (with a binding name) is a genuine reference; the
binding identifier must not be mistaken for a type.
