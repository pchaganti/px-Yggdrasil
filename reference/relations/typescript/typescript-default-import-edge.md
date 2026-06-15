---
id: typescript-default-import-edge
language: typescript
category: import
expectation: edge
cites: "TS Handbook — Modules (default import binds the module's default export; the specifier is the dependency); research A1"
---

## Rule

A default import `import x from './m'` binds the module's default export to a local
name; the relative specifier `'./m'` is the dependency, never the binding `x`. The
extractor reads only the statement's `source` field, so the local name is irrelevant.
The relative specifier resolves by relative join onto the importing file's directory
plus extension probing, pinning exactly one target file.

## Files

```ts path=r/m/value.ts
export default function helloWorld() {}
```

```ts path=r/app/use.ts
import helloWorld from '../m/value';
helloWorld();
```

## Expect

- r/app/use.ts:1 -> node:m      # `import helloWorld from '../m/value'` resolves to r/m/value.ts (node m)

## Why

The specifier is the edge and the binding form is irrelevant; the relative join pins
the importing module's directory so a same-basename file elsewhere is unreachable.
