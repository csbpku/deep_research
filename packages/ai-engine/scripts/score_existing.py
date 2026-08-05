"""Score existing radar candidates with Distilled v2 in-place."""
# ruff: noqa: E402
import asyncio
import argparse
import json
import os
import sys
from datetime import date
from typing import Any
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.distilled_scorer import (
    DistilledScore,
    ScoringMonitor,
    compute_score,
    score_with_llm,
)
from ai_engine.scoring.scoring_profiles import get_profile

_SOURCE_PROFILE: dict[str, str] = {
    "arxiv": "paper",
    "github": "engineering",
    "github_trending": "engineering",
    "devto": "engineering",
    "producthunt": "engineering",
    "rss": "news",
    "hackernews": "news",
    "reddit": "news",
    "lobsters": "news",
    "wechat": "news",
    "vendor_news": "news",
}


async def main() -> int:
    parser = argparse.ArgumentParser(description="Re-score existing radar candidates")
    parser.add_argument(
        "--source-type",
        choices=sorted(_SOURCE_PROFILE),
        default=None,
        help="Only score candidates from this source type",
    )
    parser.add_argument(
        "--rescore",
        action="store_true",
        help="Re-score rows that already have a distilled score",
    )
    parser.add_argument("--limit", type=int, default=80)
    parser.add_argument(
        "--concurrency",
        type=int,
        default=int(os.environ.get("RADAR_RESCORE_CONCURRENCY", "8")),
        help="Maximum concurrent LLM scoring calls",
    )
    parser.add_argument(
        "--date",
        default=date.today().isoformat(),
        help="Only score candidates for this summary date (YYYY-MM-DD; defaults to today)",
    )
    parser.add_argument(
        "--recalibrate-only",
        action="store_true",
        help="Recompute tiers/effective scores from stored dimensions without LLM calls",
    )
    args = parser.parse_args()

    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()

    async with store.pool.connection() as conn:
        rows = await (await conn.execute(
            'SELECT "id", "title", "body", "url", "publishedAt", "syncRunId", '
            '  "distilledScore", "distilledProfile", '
            '  (SELECT s."sourceType" FROM "radar_sync_runs" r '
            '   JOIN "radar_sources" s ON s."id" = r."sourceId" '
            '   WHERE r."id" = "summaries"."syncRunId" LIMIT 1) AS "sourceType" '
            'FROM "summaries" WHERE "source" = \'daily\' '
            'AND "syncRunId" IS NOT NULL '
            'AND "summaryDate" = %s::date '
            + ('' if args.rescore else 'AND "distilledScore" IS NULL ')
            + ('AND (SELECT s."sourceType" FROM "radar_sync_runs" r '
               'JOIN "radar_sources" s ON s."id" = r."sourceId" '
               'WHERE r."id" = "summaries"."syncRunId" LIMIT 1) = %s '
               if args.source_type else '')
            + 'LIMIT %s',
            (args.date,)
            + ((args.source_type,) if args.source_type else ())
            + (args.limit,)
        )).fetchall()

    concurrency = max(1, args.concurrency)
    score_gate = asyncio.Semaphore(concurrency)

    async def score_row(raw: Any) -> tuple[dict[str, Any], DistilledScore]:
        row = dict(raw)
        title = str(row["title"])
        body = str(row.get("body", "") or title)
        source_type = str(row.get("sourceType", "rss"))

        profile_id = _SOURCE_PROFILE.get(source_type, "engineering")
        profile = get_profile(profile_id)
        url = str(row.get("url", "") or "")
        published_at = row.get("publishedAt")
        stored = row.get("distilledScore")
        if args.recalibrate_only and isinstance(stored, dict):
            dimensions = stored.get("dimensions")
            parsed = dict(dimensions) if isinstance(dimensions, dict) else {}
            parsed["directRelevance"] = stored.get("directRelevance")
            parsed["relevanceEvidence"] = stored.get("relevanceEvidence")
            parsed["veto"] = stored.get("veto")
            risk_flags = stored.get("riskFlags") or []
            parsed["risk_flag"] = "security_risk" if "security_review_required" in risk_flags else None
            parsed["suspected_repost"] = "suspected_repost" in risk_flags
            result = compute_score(
                parsed,
                profile=profile,
                source_type=source_type,
            )
        else:
            async with score_gate:
                result = await score_with_llm(
                    title, body,
                    profile=profile,
                    source_type=source_type,
                    url=url,
                    published_at=published_at,
                )
        return row, result

    scored_rows = await asyncio.gather(*(score_row(raw) for raw in rows))
    monitor = ScoringMonitor()
    async with store.pool.connection() as conn:
        for scored, (row, result) in enumerate(scored_rows, start=1):
            monitor.record(result)
            await conn.execute(
                'UPDATE "summaries" SET '
                '"distilledScore" = %s::jsonb, '
                '"distilledTotal" = %s, '
                '"distilledTier" = %s, '
                '"distilledMustRead" = %s, '
                '"distilledProfile" = %s '
                'WHERE "id" = %s',
                (
                    json.dumps(result.to_dict(), ensure_ascii=False),
                    result.effective_total if result.effective_total is not None else result.total,
                    result.tier,
                    result.must_read,
                    result.profile_id,
                    row["id"],
                ),
            )
            print(f"  [{scored:3d}] {str(row['title'])[:60]:<60s} | {result.total:4.0f} | {result.tier:10s} | {result.profile_id}")

    alerts = monitor.evaluate()
    print(f"\n  Scored: {monitor.total_count}  Default: {monitor.default_count}  Must-read: {monitor.must_read_count}")
    if alerts:
        print(f"  Alerts: {alerts}")
    await store.close()
    return 0


if __name__ == "__main__":
    exit(asyncio.run(main()))
