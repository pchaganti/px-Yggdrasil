---
id: typescript-namespace-import-edge
language: typescript
category: import
expectation: edge
cites: "TS Handbook — Modules (`import * as ns` binds the whole module object); research A3"
---

## Rule

A namespace import `import * as ns from './m'` binds the whole module object — a real
runtime dependency on the module. Treating `* as` as "no specific binding, no edge"
would miss the dependency; the extractor reads the `source` field and ignores the
binding form, so the namespace import emits the same single edge as any other static
import.

## Files

```ts path=r/m/value.ts
export const a = 1;
```

```ts path=r/app/use.ts
import * as ns from '../m/value';
console.log(ns.a);
```

## Expect

- r/app/use.ts:1 -> node:m      # `import * as ns from '../m/value'` resolves to r/m/value.ts (node m)

## Why

A namespace binding is a genuine whole-module dependency; the specifier carries the
edge irrespective of the `* as` binding form.
