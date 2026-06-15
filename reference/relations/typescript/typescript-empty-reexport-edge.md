---
id: typescript-empty-reexport-edge
language: typescript
category: import
expectation: edge
cites: "TS Modules Reference — re-exports (an empty clause is not provably type-only; the module is still loaded); research C4"
---

## Rule

An empty re-export clause `export {} from './empty'` has zero specifiers. It is not
provably type-only, and the module is still loaded at runtime (its side effects run).
The all-inline-type guard requires at least one type specifier, so an empty clause
returns false and the edge is conservatively kept — over-recording a real load is
zero-FP-safe.

## Files

```ts path=r/empty/value.ts
globalThis.loaded = true;
```

```ts path=r/app/use.ts
export {} from '../empty/value';
```

## Expect

- r/app/use.ts:1 -> node:empty      # `export {} from '../empty/value'` is not provably type-only → keeps the edge to node:empty

## Why

An empty re-export still loads the target module; conservatively keeping the edge
over-records a real runtime load rather than risking a missed dependency.
