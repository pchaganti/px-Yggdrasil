---
id: csharp-bare-member-type
language: csharp
category: usage-site
expectation: edge
cites: "C# spec §15.5 (fields); §7.8 (simple-name lookup); MS Learn — field declarations"
---

## Rule

A bare (unqualified, non-generic) type in a field/parameter/return position is a
type reference. Under `using N;`, the bare name `Foo` in `Foo _f;` acquires the
`N.Foo` candidate, so a member typed only as `Foo` — never constructed, never a
base — is still a real dependency on the node declaring `N.Foo`.

## Files

```csharp path=src/c/Use.cs
using N;
class C { Foo _f; }
```

```csharp path=src/n/Foo.cs
namespace N;
public class Foo {}
```

## Expect

- src/c/Use.cs:2 -> node:n      # bare member type `Foo` binds N.Foo (node n)

## Why

A dependency expressed only as a member type would otherwise be invisible; the
detection must reach bare identifiers in member positions, not only base/new.
