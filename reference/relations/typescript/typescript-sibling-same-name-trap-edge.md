---
id: typescript-sibling-same-name-trap-edge
language: typescript
category: trap
expectation: edge
cites: "TS Module Resolution (the relative join pins the importing module's directory; a same-basename sibling elsewhere is unreachable); research B5/F1"
---

## Rule

The relative join pins the importing file's directory, so a same-basename file in another
directory is structurally unreachable. `'../m/value'` from `r/app/use.ts` joins to
`r/m/value.ts` (node m); the same-named `r/other/value.ts` (node other) is never in the
candidate set and can never be mis-chosen. The edge binds the path-pinned target, never
the coincidental same-leaf sibling.

## Files

```ts path=r/m/value.ts
export const X = 1;
```

```ts path=r/other/value.ts
export const X = 2;
```

```ts path=r/app/use.ts
import { X } from '../m/value';
console.log(X);
```

## Expect

- r/app/use.ts:1 -> node:m      # `'../m/value'` resolves to r/m/value.ts (node m), never the same-named r/other/value.ts

## Why

The decisive resolution-axis guard: a coincidental same-basename file under a different
directory must not be chosen over the path-pinned target; the relative join makes the
sibling unreachable.
