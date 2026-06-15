---
id: typescript-directory-index-edge
language: typescript
category: import
expectation: edge
cites: "TS Module Resolution (directory `index` fallback after direct-file candidates); research F1"
---

## Rule

A relative specifier naming a DIRECTORY falls through to the `index.{ts,tsx,js,jsx}`
fallback, appended after the direct-file candidates. `'../pkg'` binds to `pkg/index.ts`
when `pkg` is a directory with an index file — a real dependency on the package barrel.

## Files

```ts path=r/pkg/index.ts
export const a = 1;
```

```ts path=r/app/use.ts
import { a } from '../pkg';
console.log(a);
```

## Expect

- r/app/use.ts:1 -> node:pkg      # `'../pkg'` directory → index fallback → r/pkg/index.ts (node pkg)

## Why

A bare directory specifier loads its `index` barrel; the index fallback is probed only
after direct-file candidates so a same-named file always beats a directory.
