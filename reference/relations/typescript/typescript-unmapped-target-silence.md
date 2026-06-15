---
id: typescript-unmapped-target-silence
language: typescript
category: import
expectation: silence
cites: "TS Module Resolution (a relative specifier under no existing candidate resolves to nothing); research F4"
---

## Rule

A relative specifier whose joined path matches NO existing candidate (no `.ts`/`.tsx`/
`.js`/`.jsx`/`.mjs`/`.cjs` file and no `index`) resolves to nothing → silence. The
resolver never falls back to an arbitrary same-name pick; an unresolved relative import
is a recall/coverage matter, never a false positive.

## Files

```ts path=r/app/use.ts
import { x } from '../nope/missing';
console.log(x);
```

## Expect

- silence      # `'../nope/missing'` has no existing candidate file → resolves to nothing → no edge

## Why

Pointing an edge at a file that does not exist would manufacture a target; the resolver
requires a real existing candidate, so an unresolved import is silently a recall gap.
