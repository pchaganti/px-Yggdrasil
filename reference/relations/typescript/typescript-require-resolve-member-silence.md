---
id: typescript-require-resolve-member-silence
language: typescript
category: dynamic
expectation: silence
cites: "Node — `require.resolve` returns a path string, not a module value (member callee); research D5"
---

## Rule

A `require.resolve('./x')` returns a path STRING, not a module value, and its callee is
a `member_expression`, not the bare `require` identifier. Matching the member callee
would emit an edge for code that only computes a path (the module may never load), so it
is silenced. Missing it is a tolerated recall gap, never a false positive.

## Files

```ts path=r/m/value.ts
export const a = 1;
```

```ts path=r/app/use.ts
const p = require.resolve('../m/value');
console.log(p);
```

## Expect

- silence      # `require.resolve` is a member callee, not bare `require` → computes a path, does not load → no edge

## Why

Computing a path is not loading a module; matching the member callee would manufacture a
runtime dependency that may never occur.
