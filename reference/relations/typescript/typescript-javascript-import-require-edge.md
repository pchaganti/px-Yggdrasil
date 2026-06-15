---
id: typescript-javascript-import-require-edge
language: typescript
category: import
expectation: edge
cites: "TS Handbook — Modules (the same path forms resolve in a plain `.js` file with no type syntax); research A1/D1"
---

## Rule

A JavaScript file (no type syntax) resolves the same path forms as TypeScript. A `.js`
importer with both an ESM `import x from '../m/value'` and a CommonJS
`require('../n/value')` emits two edges — one per specifier-bearing statement — and the
extractor never crashes on the type-free grammar.

## Files

```ts path=r/m/value.ts
export default function x() {}
```

```ts path=r/n/value.ts
module.exports = { go() {} };
```

```js path=r/app/use.js
import x from '../m/value';
const y = require('../n/value');
x();
y.go();
```

## Expect

- r/app/use.js:1 -> node:m      # ESM `import x from '../m/value'` resolves to r/m/value.ts (node m)
- r/app/use.js:2 -> node:n      # CJS `require('../n/value')` resolves to r/n/value.ts (node n)

## Why

The path-axis resolution is grammar-agnostic; a JavaScript importer yields the same
edges as TypeScript, one per specifier-bearing statement.
