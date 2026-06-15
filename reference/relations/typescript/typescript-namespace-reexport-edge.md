---
id: typescript-namespace-reexport-edge
language: typescript
category: import
expectation: edge
cites: "TS Modules Reference — `export * as ns from` (TS 3.8+) re-exports the module as a named namespace; research C3"
---

## Rule

A namespace re-export `export * as ns from './ns'` re-exports the module as a named
namespace — a real runtime dependency. It uses a `namespace_export` node and is never
type-only in the value form, so it must keep its edge. The type-only seal for
`export type * as` must NOT over-silence this VALUE form (which carries no `type`).

## Files

```ts path=r/ns/value.ts
export const a = 1;
```

```ts path=r/app/use.ts
export * as ns from '../ns/value';
```

## Expect

- r/app/use.ts:1 -> node:ns      # `export * as ns from '../ns/value'` resolves to r/ns/value.ts (node ns)

## Why

The value namespace re-export is a genuine runtime dependency; the type-only seal fires
only when a leading `type` marker is present, never for this bare value form.
