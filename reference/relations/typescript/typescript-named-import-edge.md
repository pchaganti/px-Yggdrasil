---
id: typescript-named-import-edge
language: typescript
category: import
expectation: edge
cites: "TS Handbook — Modules (named import lists named exports; the specifier is the single edge); research A2"
---

## Rule

A named import `import { X } from './m'` lists named exports in braces; the specifier
is the single edge regardless of how many names are imported. The extractor emits one
edge per import-bearing statement, keyed on the relative specifier, not on the count
of named bindings.

## Files

```ts path=r/m/value.ts
export const X = 1;
export const Y = 2;
```

```ts path=r/app/use.ts
import { X, Y } from '../m/value';
console.log(X, Y);
```

## Expect

- r/app/use.ts:1 -> node:m      # `import { X, Y } from '../m/value'` resolves to r/m/value.ts (node m), one edge

## Why

Multiple named bindings name one module; one edge per statement is the correct,
non-over-counting representation of the single runtime dependency.
