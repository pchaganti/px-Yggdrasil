---
id: typescript-dynamic-import-template-silence
language: typescript
category: dynamic
expectation: silence
cites: "TS Handbook — Modules (an interpolated template specifier is not statically analyzable); research E2"
---

## Rule

A template-literal dynamic import `import(`./x-${v}`)` carries a `template_string` with
interpolation, not a string literal; the runtime target is unknown. Emitting the literal
prefix would guess at the target — a false positive — so the non-literal argument is
dropped and the statement is silenced.

## Files

```ts path=r/x-a/value.ts
export const a = 1;
```

```ts path=r/app/use.ts
const d = import(`../x-${v}/value`);
```

## Expect

- silence      # interpolated template specifier is not a static literal → no resolvable target → no edge

## Why

An interpolated specifier resolves at runtime; guessing the prefix would manufacture a
target that may never be loaded.
