"""Run full radar sync with Distilled v2 scoring and show results."""
# ruff: noqa: E402
import asyncio
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))
# Override daily budget so brief calls are not throttled during testing.
os.environ["BUDGET_TEAM_DAILY"] = "500"

from ai_engine.adapters.base import build_adapter
from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.sync_runner import run_radar_sync
from ai_engine.radar.distilled_scorer import ScoringMonitor, score_with_llm
from datetime import datetime, timezone

async def main():
    print(f"\n{'='*60}")
    print(f"  Radar Full Sync — {datetime.now(timezone.utc).isoformat()}")
    print(f"{'='*60}\n")

    store = DbJobStore(dsn=os.environ.get("DATABASE_URL", "postgresql:///deep_research"))
    await store.open()
    adapter = build_adapter()

    print(f"  Adapter: {type(adapter).__name__}")
    print("  Sources: loading...")
    print()

    monitor = ScoringMonitor()
    result = await run_radar_sync(
        store.pool,
        triggered_by="admin",
        adapter=adapter,
        generation_timeout_seconds=60.0,
        distilled_scorer=score_with_llm,
        monitor=monitor,
    )

    total_new = sum(r.total_new for r in result.runs)
    total_fetched = sum(r.total_fetched for r in result.runs)
    total_skipped = sum(r.total_skipped for r in result.runs)
    total_failed = sum(r.total_failed for r in result.runs)

    print(f"  Batch: {result.batch_id[:16]}...")
    print(f"{'─'*60}")
    print(f"  {'Source':<25} {'Status':>8}  {'Fetched':>7}  {'New':>5}  {'Skip':>5}  {'Fail':>5}")
    print(f"{'─'*60}")
    for r in sorted(result.runs, key=lambda x: x.status):
        name = r.source_id[:24]
        print(f"  {name:<25} {r.status:>8}  {r.total_fetched:>7}  {r.total_new:>5}  {r.total_skipped:>5}  {r.total_failed:>5}")
        if r.error_code:
            print(f"  {'':>25} error: {r.error_code}")
    print(f"{'─'*60}")
    print(f"  {'TOTAL':<25} {'':>8}  {total_fetched:>7}  {total_new:>5}  {total_skipped:>5}  {total_failed:>5}")
    print(f"  Distilled scored: {monitor.total_count - monitor.default_count}  default: {monitor.default_count}  must-read: {monitor.must_read_count}")
    print()

    await store.close()
    return 0 if total_failed < total_new else 1

if __name__ == "__main__":
    exit(asyncio.run(main()))
