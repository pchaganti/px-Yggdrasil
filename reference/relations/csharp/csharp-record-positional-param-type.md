---
id: csharp-record-positional-param-type
language: csharp
category: usage-site
expectation: edge
cites: "C# 9 / 10 — record / record struct positional parameters; MS Learn — records"
---

## Rule

A record's positional parameters `record R(Foo A, Bar B);` are a primary
constructor; their TYPES (`Foo`, `Bar`) are real type references (and become
property types). The same holds for `record struct`. Under `using N;` each bare
parameter type acquires its `N.` candidate.

## Files

```csharp path=src/c/Use.cs
using N;
namespace App;
record R(Foo A, Bar B);
```

```csharp path=src/n/Types.cs
namespace N;
public class Foo {}
public class Bar {}
```

## Expect

- src/c/Use.cs:3 -> node:n      # record positional parameter type `Foo` binds N.Foo (node n)
- src/c/Use.cs:3 -> node:n      # record positional parameter type `Bar` binds N.Bar (node n)

## Why

Record positional parameter types sit on the declaration header and are a common
data-shape / dependency carrier; a base/member-only walker misses them.
