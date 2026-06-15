---
id: csharp-extension-receiver-type
language: csharp
category: usage-site
expectation: edge
cites: "C# 14 — extension members (extension blocks); MS Learn — what's new in C# 14"
---

## Rule

A C# 14 `extension(ReceiverType)` block names a receiver type whose named
components are real type references, resolved by ordinary name binding. Under
`using N;`, a bare receiver type acquires its `N.` candidate, so the extension block
is a dependency on the node declaring the receiver type.

## Files

```csharp path=src/c/Use.cs
using N;
static class Ext { extension(Widget source) { public void Ping() {} } }
```

```csharp path=src/n/Widget.cs
namespace N;
public class Widget {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # extension-block receiver type `Widget` binds N.Widget (node n)

## Why

The receiver type in a C# 14 extension block is a genuine reference at a novel AST
position; a walker unaware of the block skips it.
