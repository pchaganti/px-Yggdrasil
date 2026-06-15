---
id: csharp-localfn-lambda-param-type
language: csharp
category: usage-site
expectation: edge
cites: "C# — local functions; lambda expressions (explicitly-typed parameters); §7.8 name binding"
---

## Rule

A local function's RETURN type (`Foo Helper(Bar b) { … }`) and an explicitly-typed
lambda parameter (`(Baz z) => …`) are real type references resolved by §7.8 — these are
distinct AST positions a base/new/member-only walker can miss. The parameter/variable
NAMES are not types. Here the local-function return type `Account` is the in-graph
dependency.

## Files

```csharp path=src/c/Use.cs
using N;
class C { void M() { Account Build(int id) { return null; } } }
```

```csharp path=src/n/Account.cs
namespace N;
public class Account { }
```

## Expect

- src/c/Use.cs:2 -> node:n      # the local-function return type `Account` binds N.Account (node n)

## Why

A local-function return type sits inside a method body in its own AST node; explicitly-
typed lambda parameters are `parameter` nodes covered alongside method parameters. Both
are legitimate, easily-missed dependency carriers.
