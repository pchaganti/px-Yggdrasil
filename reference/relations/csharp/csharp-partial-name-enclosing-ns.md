---
id: csharp-partial-name-enclosing-ns
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §7.8 / §13.8 (namespace and type name lookup, enclosing-namespace walk); MS Learn — namespace member lookup"
---

## Rule

A partially-qualified reference `B.Type` inside `namespace A` is resolved by
walking the enclosing namespace chain innermost→outermost: `A.B.Type` is tried
before the verbatim top-level `B.Type`. The nearer enclosing-namespace binding
wins and the resolver stops there. So `B.Type` inside `namespace A` is a real
dependency on the node declaring `A.B.Type` — never on a coincidental top-level
`B.Type` in another node, which is only the LAST (verbatim) candidate.

## Files

```csharp path=src/c/Use.cs
namespace A;
class C : B.Type { }
```

```csharp path=src/n/Type.cs
namespace A.B;
public class Type {}
```

```csharp path=src/x/Type.cs
namespace B;
public class Type {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # `B.Type` binds the nearer enclosing A.B.Type (node n), not the top-level FP-trap (node x)

## Why

The decisive nearest-first FP class for partial names: a top-level `B.Type` must
not be chosen over the enclosing `A.B.Type`. Catches the real nearer dependency
and rejects the trap.
