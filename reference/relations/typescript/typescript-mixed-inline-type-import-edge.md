---
id: typescript-mixed-inline-type-import-edge
language: typescript
category: import
expectation: edge
cites: "TS 4.5 inline type modifiers (a non-type specifier keeps the runtime dependency); research B4"
---

## Rule

A MIXED inline-type import `import { type A, b } from './m'` has `b` as a runtime
binding; the `type` modifier sits inside the `A` specifier, not as a statement-level
token. The statement still pulls in `b` at runtime, so it retains a runtime dependency
on `./m`. The all-inline-type guard returns false on the first non-type specifier and
the edge is kept — over-silencing here would lose a real edge.

## Files

```ts path=r/m/value.ts
export interface A {}
export const b = 1;
```

```ts path=r/app/use.ts
import { type A, b } from '../m/value';
const a: A = {} as A;
console.log(b);
```

## Expect

- r/app/use.ts:1 -> node:m      # `b` is a runtime binding → the statement keeps its edge to r/m/value.ts (node m)

## Why

A clause with any runtime binding is a real dependency; the inline `type` on a sibling
specifier must not over-broaden the type-only guard.
