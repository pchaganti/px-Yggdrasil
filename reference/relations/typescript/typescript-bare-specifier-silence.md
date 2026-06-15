---
id: typescript-bare-specifier-silence
language: typescript
category: trap
expectation: silence
cites: "TS Module Resolution — relative vs non-relative (a bare specifier is an external package / Node builtin); research G1"
---

## Rule

A bare specifier (`lodash`, `node:path`, `@scope/pkg`) does not start with `.` or `/`,
so the relative gate rejects it as external before any resolution. This is the master
false-positive guard: even if an in-repo file coincidentally shared a basename, a bare
specifier never reaches the relative join, so it can never mis-root to it.

## Files

```ts path=r/lodash/value.ts
export const x = 1;
```

```ts path=r/app/use.ts
import x from 'lodash';
import path from 'node:path';
console.log(x, path);
```

## Expect

- silence      # `lodash` / `node:path` are non-relative → external → no edge, even though an in-repo r/lodash exists

## Why

Deciding external-vs-in-repo by probing for a same-named file would be a major false
positive source; the relative gate keeps external specifiers out of the in-repo tree
unconditionally.
