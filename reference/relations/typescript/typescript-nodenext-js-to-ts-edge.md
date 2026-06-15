---
id: typescript-nodenext-js-to-ts-edge
language: typescript
category: import
expectation: edge
cites: "TS 4.7 NodeNext (the source imports the `.js` output extension; only the `.ts` exists on disk); research F2"
---

## Rule

Under NodeNext the SOURCE imports the `.js` output extension even though only the `.ts`
source exists on disk. The resolver rewrites `.js → [.ts, .tsx, .js, .jsx]`, so an
explicit `'../esm/mod.js'` binds to `mod.ts` when that is the only file present. The
directory is still pinned by the relative join, so the rewrite adds recall with no false
positive.

## Files

```ts path=r/esm/mod.ts
export const a = 1;
```

```ts path=r/app/use.ts
import { a } from '../esm/mod.js';
console.log(a);
```

## Expect

- r/app/use.ts:1 -> node:esm      # NodeNext rewrites `.js` → tries `.ts` first → r/esm/mod.ts (node esm)

## Why

The `.js`→`.ts` rewrite is the common NodeNext case; resolving the `.js` specifier only
to a `.js` file would miss the TS source, and the rewrite never escapes the pinned
directory.
