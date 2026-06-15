---
id: typescript-all-inline-type-reexport-silence
language: typescript
category: import
expectation: silence
cites: "TS 4.5 inline type modifiers (every re-export specifier `type`-prefixed → erased); research C6"
---

## Rule

An all-inline-type re-export `export { type A, type B } from './t'` carries an inline
`type` modifier on EVERY export specifier; the whole statement erases at compile time.
The all-inline-type guard over the `export_clause` confirms every specifier is type-only
and silences the statement.

## Files

```ts path=r/t/types.ts
export interface A {}
export interface B {}
```

```ts path=r/app/use.ts
export { type A, type B } from '../t/types';
```

## Expect

- silence      # every re-export specifier is inline `type` → erased → no edge to node:t

## Why

A fully inline-type re-export is compile-time-only with no runtime load; emitting an
edge would be a false positive.
