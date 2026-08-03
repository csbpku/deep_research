"""Run the full daily radar pipeline once: sync -> enrichment -> digest.

Usage:
  cd packages/ai-engine
  uv run python scripts/run_radar_daily_job.py

For host-level cron (e.g. every day at 08:00 Asia/Shanghai):
  0 8 * * * cd /Users/shaobo.chen/deep_research/packages/ai-engine && \
    .venv/bin/python scripts/run_radar_daily_job.py >> logs/radar-daily.log 2>&1
"""
# ruff: noqa: E402
from __future__ import annotations

import asyncio
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.adapters.base import build_adapter
from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.sync_endpoint import run_radar_daily_job


async def main() -> int:
    dsn = os.environ.get(
        "DATABASE_URL",
        "postgresql://postgres:postgres@localhost:5432/deep_research",
    )
    store = DbJobStore(dsn=dsn)
    await store.open()
    try:
        adapter = build_adapter()
        await run_radar_daily_job(
            pool=store.pool,
            adapter=adapter,
            triggered_by="cron",
            request_id=f"cron-{uuid.uuid4()}",
        )
    finally:
        await store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
