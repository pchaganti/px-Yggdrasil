---
id: csharp-is-as-cast-operand
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §12.12 (is/as operators), §12.9.7 (cast_expression); MS Learn — type-testing and cast operators"
---

## Rule

The type operand of an `as X`, a cast `(Y)x`, and an `is Z` pattern are each type
references. Under `using N;`, each bare operand (`X`, `Y`, `Z`) acquires its `N.`
candidate, so each is a real dependency on the node declaring it. Here all three
operands live in one node, so all three references bind that node.

## Files

```csharp path=src/c/Use.cs
using N;
class C { void M(object o) { var a = o as X; var b = (Y)o; if (o is Z) {} } }
```

```csharp path=src/n/Types.cs
namespace N;
public class X {}
public class Y {}
public class Z {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # `as X` binds N.X (node n)
- src/c/Use.cs:2 -> node:n      # cast `(Y)o` binds N.Y (node n)
- src/c/Use.cs:2 -> node:n      # `is Z` binds N.Z (node n)

## Why

`is`/`as`/cast operands are real type references; each must be detected and
resolved.
