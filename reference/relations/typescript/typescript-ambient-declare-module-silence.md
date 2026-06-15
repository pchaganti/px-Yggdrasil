---
id: typescript-ambient-declare-module-silence
language: typescript
category: trap
expectation: silence
cites: "TS Modules Reference — ambient modules / pattern ambient modules (`declare module '*.css'` declares a shape, names no file); research H3 (DELIBERATE-SILENCE)"
---

## Rule

An ambient module declaration `declare module 'foo' { … }` (and the wildcard pattern
`declare module '*.css'`) declares the SHAPE of an external module without providing its
implementation; the actual module is supplied by a bundler/loader at runtime. The header
string (`'foo'`, `'*.css'`) is never read as a module specifier — mapping it to an
in-repo `foo.ts` would be a phantom. (A real `import`/`require` NESTED inside such a
block would still emit, correctly; the header alone names nothing.)

## Files

```ts path=r/foo/value.ts
export const x = 1;
```

```ts path=r/app/use.ts
declare module 'foo' {
  export const x: number;
}
declare module '*.css' {
  const url: string;
  export default url;
}
```

## Expect

- silence      # `declare module 'foo'` / `'*.css'` headers are shape declarations, not specifiers → no edge, even though r/foo exists

## Why

An ambient declaration's header names no in-repo file; reading it as a specifier would
manufacture a dependency on a same-named directory that the declaration never references.
