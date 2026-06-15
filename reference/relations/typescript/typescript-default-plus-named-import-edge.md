---
id: typescript-default-plus-named-import-edge
language: typescript
category: import
expectation: edge
cites: "TS Handbook — Modules (default and named clauses can co-occur; still one module); research A5"
---

## Rule

A combined `import def, { a } from './m'` carries a default clause and a named clause
that both name the SAME module; it is one runtime dependency, one edge. The extractor
emits exactly one path hint for the statement, deduplicated per specifier-and-line, so
the two clauses never produce two edges.

## Files

```ts path=r/m/value.ts
export default function def() {}
export const a = 1;
```

```ts path=r/app/use.ts
import def, { a } from '../m/value';
def();
console.log(a);
```

## Expect

- r/app/use.ts:1 -> node:m      # `import def, { a } from '../m/value'` resolves to r/m/value.ts (node m), exactly one edge

## Why

Default plus named clauses name one module; one edge correctly represents the single
dependency without double counting.
