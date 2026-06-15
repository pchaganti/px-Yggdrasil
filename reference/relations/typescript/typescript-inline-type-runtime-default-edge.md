---
id: typescript-inline-type-runtime-default-edge
language: typescript
category: import
expectation: edge
cites: "TS 4.5 inline type modifiers (a runtime default binding keeps the dependency); research B5"
---

## Rule

An import `import def, { type A } from './m'` has every NAMED specifier type-only, but
the default binding `def` is a runtime binding, so the statement has a runtime
dependency on `./m`. The runtime-binding short-circuit detects the default identifier
on the import clause and keeps the edge before the named-clause type check runs.

## Files

```ts path=r/m/value.ts
export default function def() {}
export interface A {}
```

```ts path=r/app/use.ts
import def, { type A } from '../m/value';
def();
const a: A = {} as A;
```

## Expect

- r/app/use.ts:1 -> node:m      # default `def` is a runtime binding → keeps the edge to r/m/value.ts (node m)

## Why

A runtime default binding makes the statement a real dependency even when every named
specifier is type-only; the edge must be kept.
