---
id: typescript-export-equals-require-edge
language: typescript
category: import
expectation: edge
cites: "TS Handbook — Modules (`export = require('./m')` re-exports a required module); research D3"
---

## Rule

A CommonJS export-assignment of a require `export = require('./e')` re-exports a required
module — a real runtime dependency. The edge comes from the nested `require('./e')` call
expression (caught by the call-expression branch), not the export-assignment node, so no
special handling of `export =` is needed.

## Files

```ts path=r/e/value.ts
module.exports = { go() {} };
```

```ts path=r/app/use.ts
export = require('../e/value');
```

## Expect

- r/app/use.ts:1 -> node:e      # nested `require('../e/value')` resolves to r/e/value.ts (node e)

## Why

The nested `require` call is the real module load; the export-assignment wrapper adds no
specifier of its own, so the edge is recorded once from the require.
