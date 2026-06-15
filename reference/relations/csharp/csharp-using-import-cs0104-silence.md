---
id: csharp-using-import-cs0104-silence
language: csharp
category: trap
expectation: silence
cites: "C# CS0104 (ambiguous reference between two imported namespaces); MS Learn — CS0104"
---

## Rule

When `using A;` and `using B;` both import a type named `Foo` (from DIFFERENT
nodes), the simple name `Foo` is ambiguous — CS0104. The resolver must SILENCE
rather than bind the first import it happens to see; committing to one arbitrary
import would be a false positive.

## Files

```csharp path=src/c/Use.cs
using A;
using B;
class C : Foo { }
```

```csharp path=src/a/Foo.cs
namespace A;
public class Foo {}
```

```csharp path=src/b/Foo.cs
namespace B;
public class Foo {}
```

## Expect

- silence      # both `A.Foo` and `B.Foo` are imported → ambiguous simple name `Foo` → no edge

## Why

Two same-named imports make the simple name ambiguous; binding either arbitrary
node would be a coin-flip false positive. Silence is the spec-correct outcome.
