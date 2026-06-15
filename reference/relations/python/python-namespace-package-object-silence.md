---
id: python-namespace-package-object-silence
language: python
category: import
expectation: silence
cites: "PEP 420 — a namespace package is a directory with no `__init__.py` (no single backing source file); research 2026-06-15 PART D §D3b"
---

## Rule

Importing the NAMESPACE PACKAGE OBJECT itself — `import plugins` where `plugins/` is a
PEP 420 namespace package (no `__init__.py`) — resolves to nothing. The resolver probes
`plugins.py` and `plugins/__init__.py`; both are ABSENT for a namespace package, so it
returns undefined → silence. A namespace package has no single backing FILE (it is a
directory, possibly split across portions owned by different nodes), so there is nothing
to attribute the edge to. Silence is zero-FP; picking an arbitrary file in `plugins/`
would risk the split-owner FP.

## Files

```python path=src/plugins/audit.py
def record():
    pass
```

```python path=src/app/main.py
import plugins
```

## Expect

- silence      # `plugins/` has no __init__.py and no plugins.py → no backing file → no edge (the submodule file is not what `import plugins` names)

## Why

A namespace package object maps to a directory, not a file; the graph maps targets by
file, so resolving `import plugins` to any single file would manufacture a target —
silence preserves the no-directory-listing invariant and stays zero-FP. (Contrast the
submodule case, where `from plugins import audit` DOES resolve, because the submodule file
is probed directly.)
