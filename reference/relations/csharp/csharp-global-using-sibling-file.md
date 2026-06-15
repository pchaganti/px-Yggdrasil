---
id: csharp-global-using-sibling-file
language: csharp
category: import
expectation: edge
cites: "C# spec §13.4 (global using, project-wide scope); MS Learn — global using directives"
---

## Rule

A `global using N;` applies PROJECT-WIDE: a directive declared in one file makes
namespace `N` imported in EVERY file of the project, not only the declaring file.
So a bare base name `Type` in a file with no local using still acquires the
`N.Type` candidate when a sibling file declares `global using N;`. The relation
pass aggregates every file's global-using prefixes in a pre-pass before resolving
simple names, then injects that set as each file's lowest using tier. The bare
`Type` therefore binds `N.Type`.

## Files

```csharp path=src/g/Globals.cs
global using N;
```

```csharp path=src/c/Use.cs
class C : Type { }
```

```csharp path=src/n/Type.cs
namespace N;
public class Type {}
```

## Expect

- src/c/Use.cs:1 -> node:n      # bare `Type` qualifies via the sibling-file `global using N;` (node n)

## Why

A global using is invisible at the point of use; only project-wide aggregation
before resolution finds the edge. Declared global usings aggregate; implicit/SDK
ones stay invisible to a source-only tool and are correctly never invented.
