---
id: typescript-relative-resolves-js-edge
language: typescript
category: import
expectation: edge
cites: "TS Module Resolution (`.js` source fallback when no `.ts` twin exists); research F1"
---

## Rule

When an extension-less relative specifier has no `.ts`/`.tsx` twin, the resolver falls
through to the `.js` source candidate. `'../legacy/mod'` binds to `mod.js` when only the
`.js` file exists — a real cross-node dependency on a plain JavaScript module.

## Files

```js path=r/legacy/mod.js
exports.go = function () {};
```

```ts path=r/app/use.ts
import { go } from '../legacy/mod';
go();
```

## Expect

- r/app/use.ts:1 -> node:legacy      # `'../legacy/mod'` falls through to r/legacy/mod.js (node legacy)

## Why

A JavaScript source with no TypeScript twin is still a real module; the ordered
extension probe reaches it without mis-binding a same-name file elsewhere.
