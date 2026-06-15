---
id: python-external-import-silence
language: python
category: builtin
expectation: silence
cites: "Python import system — the path based finder (third-party packages live in site-packages, not the repo); research 2026-06-15 §PY6"
---

## Rule

A third-party import (`numpy`, `requests`, `django`) emits a specifier but resolves to
nothing in-repo — its source lives in site-packages, never under a repo source root — so
resolution misses and silences. The `as` alias is the local binding only; the extractor
emits the real module `numpy`, never the alias `np`, and `numpy` has no in-repo file → no
edge.

## Files

```python path=src/app/main.py
import numpy as np

a = np.array([1, 2, 3])
```

## Expect

- silence      # `numpy` resolves to no in-repo file → no edge; the alias `np` is never a target

## Why

Third-party names resolve to nothing under the repo's source roots, so the resolution-miss
guard silences them; a coincidental in-repo leaf is reached only by its own genuine path,
never by an external name.
