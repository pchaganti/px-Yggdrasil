---
id: typescript-import-meta-resolve-silence
language: typescript
category: dynamic
expectation: silence
cites: "MDN — import.meta.resolve() (resolves a specifier to a URL; does not load the module); research H5 (DELIBERATE-SILENCE)"
---

## Rule

`import.meta.resolve('./x')` computes a URL string using the current module's URL as
base; it "only performs resolution and does not attempt to load or import the resulting
path." Its callee is a `member_expression` (`import.meta.resolve`), not the bare `import`
callee of a dynamic `import()`, so the dynamic-import branch never matches it. Treating
it like a dynamic import would be a false positive — computing a URL is not loading a
module.

## Files

```ts path=r/m/value.ts
export const a = 1;
```

```ts path=r/app/use.ts
const u = import.meta.resolve('../m/value');
console.log(u);
```

## Expect

- silence      # `import.meta.resolve` computes a URL, not a load; member callee, not bare `import` → no edge

## Why

Resolving a URL is not importing a module; matching the member callee would manufacture a
runtime dependency on code that may never be loaded — analogous to `require.resolve`.
