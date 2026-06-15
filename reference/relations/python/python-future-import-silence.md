---
id: python-future-import-silence
language: python
category: builtin
expectation: silence
cites: "Python Language Reference §7.11 future statements — `from __future__ import …` is a compiler directive parsed as a distinct node; research 2026-06-15 PART E §E4"
---

## Rule

`from __future__ import annotations` is a compiler directive, not a module dependency.
Tree-sitter parses it as a distinct `future_import_statement` node, never an
`import_from_statement`, so the import-from case never visits it — the `__future__`
pseudo-module is silenced BY CONSTRUCTION. The pseudo-feature names (`annotations`,
`division`, …) are not modules and name no file.

## Files

```python path=src/app/main.py
from __future__ import annotations


def run() -> "int":
    return 0
```

## Expect

- silence      # `from __future__` parses as future_import_statement → never an edge node

## Why

The distinct AST node type means the extractor structurally cannot emit a `__future__`
specifier; even if it did, `__future__` resolves to no in-repo file, so the silence is
doubly safe.
