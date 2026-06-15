---
id: csharp-file-scoped-namespace-fqn
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §13.3 (file_scoped_namespace_declaration); MS Learn — file-scoped namespace (C# 10)"
---

## Rule

A file-scoped `namespace X;` declaration qualifies every type declared in that
file: `class C` becomes the fully-qualified type `X.C`. A reference from another
node spelled `X.C` therefore binds the type declared under the file-scoped
namespace — proving the declaration was keyed with its namespace prefix.

## Files

```csharp path=src/x/T.cs
namespace X;
class C { }
```

```csharp path=src/c/Use.cs
namespace Other;
class D { void M() { var o = new X.C(); } }
```

## Expect

- src/c/Use.cs:2 -> node:x      # `new X.C()` binds the file-scoped-namespace type X.C (node x)

## Why

If a file-scoped namespace failed to qualify its declarations, the FQN reference
would find nothing and the real dependency would be missed.
