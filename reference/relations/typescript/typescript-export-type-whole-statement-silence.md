---
id: typescript-export-type-whole-statement-silence
language: typescript
category: import
expectation: silence
cites: "TS 5.0 verbatimModuleSyntax (`export type { X } from` is a compile-time-only re-export); research C5"
---

## Rule

A whole-statement type re-export `export type { X } from './t'` carries a statement-level
`type` token before the `export_clause`; it is a compile-time-only re-export, erased at
compile time. Emitting an edge would flag a runtime dependency that does not exist. The
guard finds the leading `type` marker before the clause and silences the statement.

## Files

```ts path=r/t/types.ts
export interface X {}
```

```ts path=r/app/use.ts
export type { X } from '../t/types';
```

## Expect

- silence      # `export type { X } from` erases at compile time → no runtime edge to node:t

## Why

A type-only re-export loads no runtime module; emitting an edge there is the same false
positive as a whole-statement `import type`.
