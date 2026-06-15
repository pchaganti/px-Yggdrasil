---
id: typescript-export-type-star-reexport-silence
language: typescript
category: trap
expectation: silence
cites: "TS 5.0 type modifiers on `export *` (`export type * [as ns] from` is type-only, erased; ERROR-wrapped `type` marker seal); research C8 (SEALED genuine FP)"
---

## Rule

The SEALED genuine false-positive. `export type * from './t'` (and the aliased
`export type * as T from './t'`) is a TYPE-ONLY star/namespace re-export valid since
TypeScript 5.0; it erases at compile time and carries no runtime dependency. The current
tree-sitter grammar does not model `export type *`, so it parses the leading `type`
keyword into an `ERROR` node before the `*`. The guard recognizes an `ERROR` node whose
text is EXACTLY `type` as the whole-statement type marker (matched verbatim so an
unrelated parse error never trips it) and silences the statement — previously this
emitted a spurious runtime edge.

## Files

```ts path=r/t/types.ts
export interface A {}
```

```ts path=r/app/use.ts
export type * from '../t/types';
```

## Expect

- silence      # `export type *` (ERROR-wrapped `type` marker) erases at compile time → no runtime edge to node:t

## Why

The grammar's ERROR-wrapped `type` keyword once slipped past the type guard and emitted
a runtime edge over a compile-time-only re-export; recognizing it verbatim seals that
false positive while never tripping on an unrelated parse error.
