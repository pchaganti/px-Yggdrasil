---
id: typescript-import-type-whole-statement-silence
language: typescript
category: import
expectation: silence
cites: "TS 4.5 / 5.0 verbatimModuleSyntax (`import type` is dropped entirely at compile time); research B1"
---

## Rule

A whole-statement `import type { T } from './t'` carries a `type` token as a direct
child of the statement, before the import clause; it erases at compile time and is NOT
a runtime dependency. Emitting an edge would flag a `relation-undeclared-dependency`
over a module the consumer has zero runtime dependency on — a genuine false positive.
The extractor recognizes the leading `type` marker and silences the statement.

## Files

```ts path=r/t/types.ts
export interface T {}
```

```ts path=r/app/use.ts
import type { T } from '../t/types';
const x: T = {} as T;
```

## Expect

- silence      # `import type { T }` erases at compile time → no runtime edge to node:t

## Why

A compile-time-only type import names no runtime dependency; emitting an edge there is
the cardinal false positive this guard exists to prevent.
