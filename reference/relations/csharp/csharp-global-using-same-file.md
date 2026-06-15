---
id: csharp-global-using-same-file
language: csharp
category: import
expectation: edge
cites: "C# spec §13.4 (global using); MS Learn — global using directives (C# 10)"
---

## Rule

A `global using N;` directive imports namespace `N` project-wide. In the file that
declares it, a bare base name `Type` therefore acquires the candidate `N.Type`
exactly as an ordinary `using N;` would. So `Type` is a real dependency on the
node declaring `N.Type`.

## Files

```csharp path=src/c/Use.cs
global using N;
class C : Type { }
```

```csharp path=src/n/Type.cs
namespace N;
public class Type {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # `global using N;` qualifies bare `Type` as N.Type (node n)

## Why

Confirms a global-using declared in the consuming file is honored when expanding
simple names — the baseline of project-wide using aggregation.
