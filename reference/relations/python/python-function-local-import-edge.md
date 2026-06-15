---
id: python-function-local-import-edge
language: python
category: nested
expectation: edge
cites: "Python import system — an import statement at any block depth is a real import (lazy/function-local imports); research 2026-06-15 PART F §F2"
---

## Rule

A function-local `def f(): import lazy_mod` is a real `import_statement` inside the
function body. The extractor's walk is unconditional over the entire tree, so nesting
depth is irrelevant: `import billing.charge` inside a function resolves to
`billing/charge.py` exactly as a top-level import would — a real cross-node edge keyed to
the import line.

## Files

```python path=src/billing/charge.py
def charge():
    pass
```

```python path=src/app/main.py
def run():
    import billing.charge

    billing.charge.charge()
```

## Expect

- src/app/main.py:2 -> node:billing      # the function-local `import billing.charge` → billing/charge.py (node billing)

## Why

Laziness defers WHEN the module loads, not WHAT is depended on; a real import statement at
any depth establishes the same dependency, so the walk records it regardless of placement.
