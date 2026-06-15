---
id: python-stdlib-import-silence
language: python
category: builtin
expectation: silence
cites: "Python import system — the path based finder (stdlib modules live in the toolchain, not the repo); research 2026-06-15 §PY6"
---

## Rule

A standard-library import (`os`, `sys`, `json`) emits a specifier — the extractor cannot
know it is stdlib — but resolves to nothing IN-REPO: no `os.py` / `os/__init__.py` exists
under any source root, so the resolution-miss master guard returns undefined → silence.
The fixture has a real `billing/charge.py`, proving `os` is not mis-rooted to a
coincidental in-repo file.

## Files

```python path=src/billing/charge.py
def charge():
    pass
```

```python path=src/app/main.py
import os

print(os.getcwd())
```

## Expect

- silence      # `os` has no in-repo file → resolution miss → no edge

## Why

Resolution-miss silence is the universal false-positive guard: a stdlib name whose file
is absent from the repo resolves to nothing and is never flagged, so it can never be
mis-attributed to an unrelated in-repo module.
