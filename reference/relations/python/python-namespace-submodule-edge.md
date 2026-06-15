---
id: python-namespace-submodule-edge
language: python
category: import
expectation: edge
cites: "PEP 420 — Implicit Namespace Packages (a directory with no `__init__.py` can still contain importable submodule files); research 2026-06-15 PART D §D3a"
---

## Rule

Importing a SUBMODULE inside a PEP 420 namespace package resolves even with no
`__init__.py` in the package directory, because the resolver probes the submodule FILE
directly. From `src/app/main.py`, `from plugins import audit` where `plugins/` has NO
`__init__.py` but `plugins/audit.py` exists: the base `plugins` candidate probes
`plugins.py` / `plugins/__init__.py` and misses harmlessly, while the longest-match
`plugins.audit` hits `plugins/audit.py` (node `plugins`). The missing `__init__.py` is
irrelevant — the submodule file is what is probed, and it exists.

## Files

```python path=src/plugins/audit.py
def record():
    pass
```

```python path=src/app/main.py
from plugins import audit

audit.record()
```

## Expect

- src/app/main.py:1 -> node:plugins      # `plugins.audit` → plugins/audit.py even with no plugins/__init__.py (namespace package submodule)

## Why

A submodule inside a namespace package is a real file and a real dependency; file-path
probing is `__init__`-independent, so the common namespace-package case resolves
correctly with no guess and no FP.
