---
id: typescript-star-reexport-edge
language: typescript
category: import
expectation: edge
cites: "TS Modules Reference — `export * from` re-exports all named exports; research C2"
---

## Rule

A star re-export `export * from './x'` re-exports all named exports of the target — a
real runtime dependency. With no `export_clause` and no `type` marker, the statement
falls through the type guards to emit a single edge on its `source` field.

## Files

```ts path=r/x/value.ts
export const a = 1;
export const b = 2;
```

```ts path=r/app/use.ts
export * from '../x/value';
```

## Expect

- r/app/use.ts:1 -> node:x      # `export * from '../x/value'` resolves to r/x/value.ts (node x)

## Why

A star re-export loads the target and re-publishes its exports; it is a genuine runtime
dependency that must be recorded.
