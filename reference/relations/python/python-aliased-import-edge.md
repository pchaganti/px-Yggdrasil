---
id: python-aliased-import-edge
language: python
category: import
expectation: edge
cites: "Python Language Reference §7.11 — `import a.b as ab` binds the name after `as` to the imported module (the alias is the local binding only); research 2026-06-15 PART A §A3"
---

## Rule

An aliased `import a.b as ab` renames only the LOCAL binding; the dependency is on the
real module `a.b`, never on the alias `ab` (which is not a module path at all). The
extractor reads the `aliased_import`'s `name` field and never its `alias` field, so the
edge is to `billing.charge` → `billing/charge.py`; emitting the alias would invent a
phantom module.

## Files

```python path=src/billing/charge.py
def charge():
    pass
```

```python path=src/app/main.py
import billing.charge as bc

bc.charge()
```

## Expect

- src/app/main.py:1 -> node:billing      # the real module `billing.charge` is the edge; alias `bc` is never a target

## Why

The local binding is irrelevant to the dependency — every binding form names the same
real module path, so resolution keys on the module operand alone, never the alias token.
