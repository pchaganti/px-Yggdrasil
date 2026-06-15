---
id: typescript-all-inline-type-import-silence
language: typescript
category: import
expectation: silence
cites: "TS 4.5 inline type modifiers (every specifier `type`-prefixed + no runtime binding → erased); research B3"
---

## Rule

An all-inline-type named import `import { type A, type B } from './t'` carries an
inline `type` modifier on EVERY named specifier and has no default or namespace
binding, so the whole statement erases at compile time. The extractor's all-inline-type
guard confirms there is no runtime binding and that every specifier is type-only, then
silences the statement — the same erasure as a whole-statement `import type`, spelled
inline.

## Files

```ts path=r/t/types.ts
export interface A {}
export interface B {}
```

```ts path=r/app/use.ts
import { type A, type B } from '../t/types';
const a: A = {} as A;
const b: B = {} as B;
```

## Expect

- silence      # every named specifier is inline `type`, no runtime binding → erased → no edge to node:t

## Why

A fully inline-type clause is a compile-time-only construct with no runtime load;
emitting an edge would be the same false positive as a whole-statement `import type`.
