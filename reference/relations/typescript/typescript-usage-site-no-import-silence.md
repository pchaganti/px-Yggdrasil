---
id: typescript-usage-site-no-import-silence
language: typescript
category: usage-site
expectation: silence
cites: "TS Handbook — Modules (a usage site only refines an already-imported binding; v1 enforces existence, not relation type); research H1/H2"
---

## Rule

A usage-site reference — `extends`, `implements`, `new`, a JSX element, a type
annotation, or a `namespace A.B` qualifier — only REFINES the relation type of a binding
that some import statement already established; it carries no new specifier. When a file
references an ancestor module's symbol through a usage site with NO specifier-bearing
statement, the extractor emits nothing: it reads only the `source` field of
specifier-bearing statements, never a usage-site name. Resolving a bare name here would
reintroduce the symbol-table name-axis trap TS/JS structurally avoids.

## Files

```ts path=r/base/Parent.ts
export class Parent {}
```

```ts path=r/app/Child.ts
declare const Parent: { new (): unknown };
class Child extends Parent {}
const c = new Child();
```

## Expect

- silence      # `extends Parent` / `new Child()` are usage sites with no specifier → no edge to node:base

## Why

The import (where present) is the edge; a usage-site name adds no second edge, and
binding a bare name across modules would be exactly the name-axis false positive the
path-only design forbids.
