"""Pipeline orchestrator.

This module wires the pure transforms together and drives a single run. Unlike
the transforms package, the orchestrator is *allowed* to observe the wall clock
and to log — timing a run and stamping its output with a run timestamp is an
orchestration concern, not a data transformation. The reproducibility rule is
deliberately scoped to the ``transforms`` package only.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from transforms import aggregate, clean

logger = logging.getLogger("pipeline")


def run(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Clean, aggregate, and package a single analytics run."""
    started = time.time()
    run_at = datetime.utcnow().isoformat()
    logger.info("pipeline run started at %s", run_at)

    cleaned = clean.strip_whitespace(rows, columns=["region", "product"])
    cleaned = clean.drop_missing(cleaned, required=["region", "amount"])
    cleaned = clean.coerce_numeric(cleaned, columns=["amount"])
    cleaned = clean.dedupe(cleaned, key="order_id")

    totals = aggregate.group_sum(cleaned, group_key="region", value_key="amount")
    counts = aggregate.group_count(cleaned, group_key="region")
    leaderboard = aggregate.top_n(totals, n=3)

    elapsed = time.time() - started
    logger.info("pipeline run finished in %.3fs", elapsed)

    return {
        "run_at": run_at,
        "elapsed_seconds": elapsed,
        "totals_by_region": totals,
        "counts_by_region": counts,
        "top_regions": leaderboard,
    }
