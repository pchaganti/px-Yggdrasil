---
id: csharp-global-qualifier-strip
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §7.8 (global:: alias-qualified name; the global namespace alias); MS Learn — global namespace alias"
---

## Rule

The `global::` qualifier names the global namespace root: `global::A.B.Base`
resolves `A.B.Base` from the root, ignoring any enclosing namespace. The
`global::` prefix is stripped and the remaining dotted name is resolved against the
global namespace. So `class C : global::A.B.Base` is a real dependency on the node
declaring `A.B.Base`.

## Files

```csharp path=src/c/Use.cs
namespace App;
class C : global::A.B.Base { }
```

```csharp path=src/g/Base.cs
namespace A.B;
public class Base {}
```

## Expect

- src/c/Use.cs:2 -> node:g      # `global::A.B.Base` strips the global qualifier and binds A.B.Base (node g)

## Why

Without stripping `global::`, the literal-qualified key never matches the dot-only
declaration and a real root-qualified dependency would be missed.
