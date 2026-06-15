---
id: typescript-package-subpath-imports-silence
language: typescript
category: trap
expectation: silence
cites: "TS Modules Reference — package.json exports/imports (`#internal/x` is non-relative, requires package.json); research G3 (DELIBERATE-SILENCE)"
---

## Rule

A `package.json` `imports` internal specifier (`#internal/x`) and an `exports` subpath
self-reference both map subpaths to files only by reading `package.json`. A `#`-prefixed
specifier does not start with `.`/`/`, so it is non-relative and silenced — the same
class as a bare specifier. Resolving it without reading `package.json` could pick the
wrong file; dropping it before resolution is zero-FP.

## Files

```ts path=r/internal/x.ts
export const x = 1;
```

```ts path=r/app/use.ts
import { x } from '#internal/x';
console.log(x);
```

## Expect

- silence      # `#internal/x` is a non-relative package.json `imports` specifier → no edge

## Why

The `#`-import map lives in package.json, which the analyzer deliberately does not parse;
silencing it before resolution keeps the in-repo tree free of guessed targets.
