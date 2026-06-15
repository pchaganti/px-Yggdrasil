---
id: csharp-block-namespace-nested-fqn
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §13.3 (namespace_declaration, nested); MS Learn — nested namespaces"
---

## Rule

Block-form `namespace A.B { namespace C { class T { } } }` concatenates the nested
namespace names: the declared type is `A.B.C.T`. A reference from another node
spelled `A.B.C.T` therefore binds it — proving nested block namespaces are keyed
by their full dotted concatenation.

## Files

```csharp path=src/t/T.cs
namespace A.B { namespace C { class T { } } }
```

```csharp path=src/c/Use.cs
namespace Other;
class D { void M() { var o = new A.B.C.T(); } }
```

## Expect

- src/c/Use.cs:2 -> node:t      # `new A.B.C.T()` binds the concatenated nested-namespace type (node t)

## Why

Nested block namespaces must concatenate; otherwise the FQN reference would not
match the declaration key and the dependency would be lost.
