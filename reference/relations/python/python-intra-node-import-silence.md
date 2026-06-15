---
id: python-intra-node-import-silence
language: python
category: usage-site
expectation: silence
cites: "Python import system — a sibling module in the same package is one node here (intra-node references are not cross-node edges); research 2026-06-15 §PY7 (granularity)"
---

## Rule

An import that resolves to a file in the SAME node as the importer is never a cross-node
edge. Files sharing a parent directory map to one node, so `from . import helper` from
`src/app/main.py` resolves `.helper` → `src/app/helper.py` (same node `app`) and `.` →
`src/app/__init__.py` (also node `app`). The import is real and resolves, but the target
is the importer's own node — intra-node, so no edge is emitted.

## Files

```python path=src/app/__init__.py
pass
```

```python path=src/app/helper.py
def assist():
    pass
```

```python path=src/app/main.py
from . import helper

helper.assist()
```

## Expect

- silence      # `.helper` → app/helper.py and `.` → app/__init__.py, both node app (same as importer) → no cross-node edge

## Why

The relation check records cross-node dependencies only; a same-package sibling is one
node, so an intra-package import can never be a cross-node edge to detect, regardless of
how the import resolves.
