---
id: typescript-dynamic-import-literal-edge
language: typescript
category: dynamic
expectation: edge
cites: "TS Handbook — Modules (dynamic `import()` loads a module; a string-literal specifier is statically resolvable); research E1"
---

## Rule

A dynamic `import('./d')` with a string-literal specifier loads a module at runtime and
is statically resolvable. The extractor matches a call whose callee is a node of type
`import` and whose first argument is a plain string literal, then emits the relative
specifier.

## Files

```ts path=r/d/value.ts
export const a = 1;
```

```ts path=r/app/use.ts
const d = import('../d/value');
```

## Expect

- r/app/use.ts:1 -> node:d      # dynamic `import('../d/value')` with a string literal resolves to r/d/value.ts (node d)

## Why

A dynamic import with a literal argument names exactly one module; it is a genuine
deferred runtime load that must be recorded.
