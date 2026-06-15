---
id: csharp-fully-qualified-base-list
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §8.1 (base class/interface, fully-qualified names); MS Learn — fully qualified type names"
---

## Rule

A fully-qualified name `A.B.C.Type` in a base list is its own exact candidate. With
no namespace context to walk, the dotted reference matches the declaration key
directly, so `class C : A.B.C.Type` is a real dependency on the node declaring
`A.B.C.Type`.

## Files

```csharp path=src/c/Use.cs
class C : A.B.C.Type { }
```

```csharp path=src/t/Type.cs
namespace A.B.C;
public class Type {}
```

## Expect

- src/c/Use.cs:1 -> node:t      # base list `A.B.C.Type` binds the FQN declaration (node t)

## Why

The simplest unambiguous dependency: a fully-qualified base type must resolve to
the node that declares it.
