---
id: csharp-plain-using-simple-name
language: csharp
category: import
expectation: edge
cites: "C# spec §13.4 (using_namespace_directive); MS Learn — using-directive (namespace import); CS0246 (unique import binds)"
---

## Rule

A `using N;` directive imports the types of namespace `N` into the file. An
unqualified base name `Type` is then a candidate for `N.Type`, and that
using-prefix expansion is NEARER than the bare verbatim spelling. So a reference
to `Type` after `using N;` is a real dependency on the node declaring `N.Type` —
never on a coincidental top-level `Type` in another namespace. The verbatim
`Type` candidate is ordered LAST; the resolver stops at the first hit, so the
imported `N.Type` wins over the unrelated top-level `Type`.

## Files

```csharp path=src/c/Use.cs
using N;
class C : Type { }
```

```csharp path=src/n/Type.cs
namespace N;
public class Type {}
```

```csharp path=src/x/Type.cs
public class Type {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # `using N;` makes bare `Type` bind N.Type (node n), never the top-level FP-trap (node x)

## Why

This is the decisive false-positive class: a top-level `Type` sharing the bare
spelling must NOT be chosen over the imported `N.Type`. Catches the real import
dependency while proving the FP-trap is rejected.
