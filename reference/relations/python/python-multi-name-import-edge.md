---
id: python-multi-name-import-edge
language: python
category: import
expectation: edge
cites: "Python Language Reference §7.11 — `import_stmt ::= \"import\" module (\",\" module)*` (each comma-separated module is an independent dependency); research 2026-06-15 PART A §A2"
---

## Rule

`import a, b` is two independent edges — one specifier per comma-separated module. The
extractor iterates every module operand of the `import_statement`, so `import billing,
shipping` resolves `billing` → `billing/__init__.py` (the package) and `shipping` →
`shipping/__init__.py`, two distinct cross-node dependencies on one line.

## Files

```python path=src/billing/__init__.py
def charge():
    pass
```

```python path=src/shipping/__init__.py
def label():
    pass
```

```python path=src/app/main.py
import billing, shipping
```

## Expect

- src/app/main.py:1 -> node:billing       # `billing` → billing/__init__.py (node billing)
- src/app/main.py:1 -> node:shipping      # `shipping` → shipping/__init__.py (node shipping)

## Why

Each comma-separated module is its own specifier and resolves independently; importing a
package binds its `__init__.py`, which is the package's owning file and the true edge.
