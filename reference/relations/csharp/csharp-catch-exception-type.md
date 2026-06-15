---
id: csharp-catch-exception-type
language: csharp
category: usage-site
expectation: edge
cites: "C# spec — try-catch (exception-handling statements); MS Learn — catch clause type"
---

## Rule

The exception type named in a `catch (FooException e)` clause is a real type reference,
resolved by the normal §7.8 name-binding rules. The bound variable name (`e`) is NOT a
type. So a `catch` over an in-graph exception type is a dependency on the node declaring
that type.

## Files

```csharp path=src/c/Use.cs
using N;
class C { void M() { try { } catch (AppError e) { } } }
```

```csharp path=src/n/AppError.cs
namespace N;
public class AppError : System.Exception { }
```

## Expect

- src/c/Use.cs:2 -> node:n      # `catch (AppError e)` binds N.AppError (node n) via the using import

## Why

A catch-clause exception type is a distinct AST position a base/new/member-only walker
misses; it is a common, real dependency on a domain exception type.
