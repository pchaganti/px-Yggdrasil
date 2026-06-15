---
id: csharp-verbatim-fqn-ambiguous-silence
language: csharp
category: trap
expectation: silence
cites: "C# CS0104 (ambiguous reference between multiple definitions); MS Learn — CS0104"
---

## Rule

When a fully-qualified name `MyApp.Dup.Thing` is declared in two different nodes,
a reference to it is present-but-ambiguous (two definitions of the same key). The
resolver must SILENCE the group rather than arbitrarily pick one — pointing at
either would be a coin-flip false positive.

## Files

```csharp path=src/z/Use.cs
namespace MyApp.Z;
class Use { void M() { var t = new MyApp.Dup.Thing(); } }
```

```csharp path=src/x/Thing.cs
namespace MyApp.Dup;
public class Thing {}
```

```csharp path=src/y/Thing.cs
namespace MyApp.Dup;
public class Thing {}
```

## Expect

- silence      # `MyApp.Dup.Thing` has two definitions (nodes x and y) → ambiguous → no edge

## Why

Two definitions of one key is CS0104; committing to either node would be an
arbitrary, possibly-wrong edge. Silence preserves zero false positives.
