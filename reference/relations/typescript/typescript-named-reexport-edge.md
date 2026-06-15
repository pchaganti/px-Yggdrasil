---
id: typescript-named-reexport-edge
language: typescript
category: import
expectation: edge
cites: "TS Modules Reference — re-exports (`export { … } from` loads the module; a `source` field is present only on re-exports); research C1"
---

## Rule

A named re-export `export { X } from './x'` re-exports another module's bindings; the
`from` clause is a real runtime dependency (the module is loaded). A `source` field is
present ONLY on a re-export — a LOCAL export (`export const y = 1`) has none and emits
nothing — so reading the `source` field cleanly separates the two.

## Files

```ts path=r/x/value.ts
export const X = 1;
```

```ts path=r/app/use.ts
export { X } from '../x/value';
```

## Expect

- r/app/use.ts:1 -> node:x      # `export { X } from '../x/value'` resolves to r/x/value.ts (node x)

## Why

A re-export loads the target module at runtime; the `source` field is the edge, while a
local export with no `from` correctly carries no dependency.
