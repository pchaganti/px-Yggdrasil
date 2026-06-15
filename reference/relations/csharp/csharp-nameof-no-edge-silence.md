---
id: csharp-nameof-no-edge-silence
language: csharp
category: dynamic
expectation: silence
cites: "C# — nameof operator (string-valued); C# 14 unbound-generic nameof; MS Learn — nameof"
---

## Rule

`nameof(X)` evaluates to the STRING `"X"`; its canonical purpose is to produce a
name without taking a hard dependency on the type. To stay zero false positives and
avoid double-counting, `nameof` is treated like a string producer and emits no type
edge — whether its operand is a type, a local, a member, or the C# 14 unbound form
`nameof(List<>)`.

## Files

```csharp path=src/c/Use.cs
using N;
class C { void M() { var n = nameof(X); } }
```

```csharp path=src/n/X.cs
namespace N;
public class X {}
```

## Expect

- silence      # `nameof(X)` yields a string, not a static type dependency → no edge

## Why

Binding a type edge from `nameof` would invent a dependency the language deliberately
avoids; silencing it preserves zero false positives.
