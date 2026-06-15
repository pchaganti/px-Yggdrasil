---
id: csharp-sdk-simple-name-silence
language: csharp
category: builtin
expectation: silence
cites: "C# spec §13.4 (implicit/SDK usings invisible to source); MS Learn — implicit usings"
---

## Rule

A bare base name with no visible using and no in-graph declaration (e.g. a type the
SDK or an implicit global using would import) has only its verbatim candidate. With
nothing in the project mapping that name to a node, it resolves to nothing — no
cross-node edge. A source-only tool cannot see implicit/SDK imports, so it must
stay silent rather than invent an edge.

## Files

```csharp path=src/c/Use.cs
class C : RepositoryBase { }
```

## Expect

- silence      # `RepositoryBase` is SDK/implicit-imported, unmapped → no edge invented

## Why

Inventing a dependency for an unresolvable SDK/implicit name would be a false
positive; silence is the spec-correct outcome.
