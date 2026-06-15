---
id: typescript-dynamic-import-non-literal-silence
language: typescript
category: dynamic
expectation: silence
cites: "TS Handbook — Modules (identifier / concatenation dynamic-import arguments are not string literals); research E3/E4"
---

## Rule

A dynamic import whose argument is an identifier `import(v)`, a concatenation
`import('./a' + v)`, or an empty string `import('')` is not a plain string-literal
specifier. An identifier and a `binary_expression` are not `string` nodes, and the empty
string is non-relative; each is silenced — emitting `./a` from `'./a' + v` would guess
the runtime target, a false positive.

## Files

```ts path=r/a/value.ts
export const a = 1;
```

```ts path=r/app/use.ts
const d1 = import(v);
const d2 = import('../a/value' + v);
const d3 = import('');
```

## Expect

- silence      # identifier / concatenation / empty-string dynamic-import arguments are not static literals → no edge

## Why

None of these arguments name a single static target; resolving any of them would be a
guess at the runtime module — a false positive.
