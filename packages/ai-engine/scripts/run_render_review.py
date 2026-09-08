"""Run the real-browser review queue once.

Usage:
  cd packages/ai-engine
  uv run python scripts/run_render_review.py --limit 1
"""

# ruff: noqa: E402
from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.render_review_worker import retry_render_review, run_render_review_once


async def main() -> int:
    parser = argparse.ArgumentParser(description="Run radar real-browser review")
    parser.add_argument("--limit", type=int, default=1)
    parser.add_argument("--summary-id", action="append", default=[])
    args = parser.parse_args()

    store = DbJobStore(
        dsn=os.environ.get(
            "DATABASE_URL",
            "postgresql://postgres:postgres@localhost:5432/deep_research",
        ),
    )
    await store.open()
    try:
        for summary_id in args.summary_id:
            queued = await retry_render_review(store.pool, summary_id=summary_id)
            print(f"{summary_id}: retry queued={queued}")
        result = await run_render_review_once(store.pool, limit=max(1, args.limit))
        print(result)
    finally:
        await store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
