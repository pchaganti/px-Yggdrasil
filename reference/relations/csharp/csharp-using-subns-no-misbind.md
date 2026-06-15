---
id: csharp-using-subns-no-misbind
language: csharp
category: trap
expectation: edge
cites: "C# spec §13.4 (using imports types of EXACTLY N, not its nested namespace B); MS Learn — using-directive scope"
---

## Rule

`using A;` does NOT import the nested namespace `A.B`, so a partial reference
`B.Type` must NOT resolve to `A.B.Type` even when such a type happens to exist.
The spec-correct binding is the real top-level `B.Type`. So when BOTH a spurious
`A.B.Type` and a real top-level `B.Type` are declared, `B.Type` binds the real
top-level one — never the using-relative sub-namespace form.

## Files

```csharp path=src/c/Use.cs
using A;
namespace App;
class C : B.Type { }
```

```csharp path=src/aB/Type.cs
namespace A.B;
public class Type {}
```

```csharp path=src/b/Type.cs
namespace B;
public class Type {}
```

## Expect

- src/c/Use.cs:3 -> node:b      # `B.Type` binds the real top-level B.Type (node b), never the using-relative A.B.Type (node aB)

## Why

Binding `A.B.Type` would be a false positive — `using A;` never imports A's nested
namespace B. The trap variant proves the resolver picks the spec-correct target
even when the spurious sub-namespace type exists.
