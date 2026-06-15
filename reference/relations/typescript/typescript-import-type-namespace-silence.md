---
id: typescript-import-type-namespace-silence
language: typescript
category: import
expectation: silence
cites: "TS 4.5 / 5.0 (`import type * as T` is a whole-statement type import, erased); research B2"
---

## Rule

A whole-statement namespace type import `import type * as T from './t'` carries the
same leading `type` marker before a `namespace_import`; it erases at compile time, so
there is no runtime dependency. The guard finds the leading `type` direct child before
the clause and silences the statement, exactly as for the named whole-statement form.

## Files

```ts path=r/t/types.ts
export interface T {}
```

```ts path=r/app/use.ts
import type * as T from '../t/types';
const x: T.T = {} as T.T;
```

## Expect

- silence      # `import type * as T` erases at compile time → no runtime edge to node:t

## Why

A type-only namespace import is erased like any other `import type`; no runtime module
is loaded, so the analyzer must emit nothing.
