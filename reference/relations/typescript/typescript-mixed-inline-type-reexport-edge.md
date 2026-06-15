---
id: typescript-mixed-inline-type-reexport-edge
language: typescript
category: import
expectation: edge
cites: "TS 4.5 inline type modifiers (a non-type re-export specifier keeps the runtime dependency); research C7"
---

## Rule

A MIXED inline-type re-export `export { type A, b } from './m'` re-exports `b` at
runtime; the `type` modifier sits inside the `A` specifier only. The statement still has
a runtime dependency on `./m`, so the all-inline-type guard returns false on the
non-type specifier `b` and the edge is kept.

## Files

```ts path=r/m/value.ts
export interface A {}
export const b = 1;
```

```ts path=r/app/use.ts
export { type A, b } from '../m/value';
```

## Expect

- r/app/use.ts:1 -> node:m      # `b` is a runtime re-export → keeps the edge to r/m/value.ts (node m)

## Why

A re-export with any runtime specifier is a real dependency; the inline `type` on a
sibling specifier must not over-broaden the guard.
