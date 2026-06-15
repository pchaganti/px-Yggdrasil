---
id: csharp-file-local-type-no-cross-file
language: csharp
category: dynamic
expectation: silence
cites: "C# 11 — file-local types (`file` modifier); MS Learn — file modifier (file-local visibility)"
---

## Rule

A C# 11 `file class Helper` is visible ONLY inside its declaring source file. Another
file CANNOT reference it, and a different file may declare an unrelated same-named
`file class Helper`. So a cross-file reference to a same-named `Helper` must NEVER bind
to a `file`-local declaration, and a `file`-local type must NEVER be published to the
shared cross-file symbol index (two files declaring same-named `file` types must not
mis-merge into one definition). Here `src/c/Use.cs` references `Helper` under the same
namespace `App`, but the only `Helper` in the graph is the `file`-local one in
`src/h/Helper.cs` — which is invisible across files — so nothing binds.

## Files

```csharp path=src/h/Helper.cs
namespace App;
file class Helper { }
```

```csharp path=src/c/Use.cs
namespace App;
class C { Helper h; }
```

## Expect

- silence      # the `file`-local `Helper` is not a cross-file target; `Helper h;` binds nothing

## Why

A `file`-local type is a hard zero-FP guard: publishing it cross-file would wrongly
bind any same-named reference to it (and merge two unrelated `file` types). The symbol
index must withhold `file`-local declarations entirely.
