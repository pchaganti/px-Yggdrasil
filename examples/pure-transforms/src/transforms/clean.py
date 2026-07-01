"""Pure cleaning transforms for the analytics pipeline.

Every function here is a deterministic mapping from inputs to outputs: given the
same rows and column definitions, it always produces the same result. This lets
the pipeline be replayed and back-filled without a run's result depending on the
wall clock, the machine, or a random seed.
"""

from __future__ import annotations

from typing import Any, Iterable


def strip_whitespace(rows: Iterable[dict[str, Any]], columns: list[str]) -> list[dict[str, Any]]:
    """Trim leading/trailing whitespace from the named string columns."""
    cleaned: list[dict[str, Any]] = []
    for row in rows:
        out = dict(row)
        for col in columns:
            value = out.get(col)
            if isinstance(value, str):
                out[col] = value.strip()
        cleaned.append(out)
    return cleaned


def drop_missing(rows: Iterable[dict[str, Any]], required: list[str]) -> list[dict[str, Any]]:
    """Drop rows where any required column is missing or empty."""
    kept: list[dict[str, Any]] = []
    for row in rows:
        if all(row.get(col) not in (None, "") for col in required):
            kept.append(dict(row))
    return kept


def coerce_numeric(rows: Iterable[dict[str, Any]], columns: list[str]) -> list[dict[str, Any]]:
    """Coerce the named columns to floats, leaving non-numeric values as None."""
    result: list[dict[str, Any]] = []
    for row in rows:
        out = dict(row)
        for col in columns:
            raw = out.get(col)
            try:
                out[col] = float(raw) if raw not in (None, "") else None
            except (TypeError, ValueError):
                out[col] = None
        result.append(out)
    return result


def dedupe(rows: Iterable[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    """Keep the first occurrence of each key value, preserving input order."""
    seen: set[Any] = set()
    unique: list[dict[str, Any]] = []
    for row in rows:
        identity = row.get(key)
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(dict(row))
    return unique
