---
id: typescript-triple-slash-reference-silence
language: typescript
category: trap
expectation: silence
cites: "TS Handbook — Triple-Slash Directives (`/// <reference path/types=… />` is a comment; targets type-only `.d.ts` / external `@types`); research H4 (DELIBERATE-SILENCE)"
---

## Rule

A triple-slash directive `/// <reference path="./other.d.ts" />` (or
`/// <reference types="node" />`) is a COMMENT to the grammar, not an import statement.
Its `path` targets are overwhelmingly type-only `.d.ts` declaration files and its `types`
targets are external `@types` packages, so treating either as a runtime edge would be a
false positive. The extractor walks AST nodes, never comment text, so the directive emits
nothing.

## Files

```ts path=r/globals/types.ts
export const g = 1;
```

```ts path=r/app/use.ts
/// <reference path="../globals/types.ts" />
/// <reference types="node" />
const x = 1;
```

## Expect

- silence      # triple-slash directives are comments targeting type-only/external artifacts → no edge, even though r/globals exists

## Why

Triple-slash references are a legacy pre-ESM mechanism aimed at declaration files;
emitting a runtime edge from a comment would be the same false positive as resolving a
`.d.ts` import.
