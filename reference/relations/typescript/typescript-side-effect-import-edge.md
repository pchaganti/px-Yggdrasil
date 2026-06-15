---
id: typescript-side-effect-import-edge
language: typescript
category: import
expectation: edge
cites: "TS Handbook — Modules (side-effect import evaluates the module's code at runtime); research A4"
---

## Rule

A side-effect import `import './polyfill'` has no binding, but the module IS evaluated
at runtime — its side effects (polyfill, CSS, registration) run, so it is a genuine
dependency. Treating "no binding ⇒ no edge" would miss an architecturally important
dependency; with no import clause the type guards do not apply, so the statement emits.

## Files

```ts path=r/m/polyfill.ts
globalThis.installed = true;
```

```ts path=r/app/use.ts
import '../m/polyfill';
```

## Expect

- r/app/use.ts:1 -> node:m      # side-effect `import '../m/polyfill'` resolves to r/m/polyfill.ts (node m)

## Why

A side-effect import loads and runs the target module; the absence of a binding does
not make it less of a runtime dependency, so the edge is kept.
