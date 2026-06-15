---
id: typescript-import-equals-require-edge
language: typescript
category: import
expectation: edge
cites: "TS Handbook — Modules (`import x = require('./m')` is TS's CommonJS-correlating import); research D2"
---

## Rule

A TS import-equals `import b = require('./b')` is TypeScript's CommonJS-correlating
import; the specifier sits on the `import_require_clause`'s `source` field. The extractor
finds the `import_require_clause` first and short-circuits the ESM-import path, emitting
the relative specifier.

## Files

```ts path=r/m/value.ts
export = { go() {} };
```

```ts path=r/app/use.ts
import b = require('../m/value');
b.go();
```

## Expect

- r/app/use.ts:1 -> node:m      # `import b = require('../m/value')` resolves to r/m/value.ts (node m)

## Why

The import-equals-require form is a genuine module load; its `source` lives on the
require clause and carries the edge.
