---
id: python-plain-import-edge
language: python
category: import
expectation: edge
cites: "Python import system — searching / submodules (`import a.b.c` imports a, then a.b, then a.b.c); Language Reference §7.11 import statement; research 2026-06-15 PART A §A1"
---

## Rule

A plain `import a.b.c` is the absolute-module edge: the fully-dotted module is the
specifier, and the analyzer resolves it by the package-layout file probe. Module-path
equals file-path, so `import billing.charge` resolves under an ancestor source root to
`billing/charge.py`. The local binding placed in the namespace (the top name `billing`)
is a usage-site fact, irrelevant to the edge — the dependency is on the deepest module
the dotted path names.

## Files

```python path=src/billing/charge.py
def charge():
    pass
```

```python path=src/app/main.py
import billing.charge

billing.charge.charge()
```

## Expect

- src/app/main.py:1 -> node:billing      # `import billing.charge` strips to billing/charge.py under the src root → node billing

## Why

The dotted module path pins exactly one file under the source root; the distinct-set
ambiguity guard means the importer's own dir can never shadow the genuine root, so this
is the safe direction — a unique probe hit is a true path-based dependency.
