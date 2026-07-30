"""Score existing radar candidates with Distilled v2 in-place."""
# ruff: noqa: E402
import asyncio
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.distilled_scorer import (
    ScoringMonitor,
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
    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()

    async with store.pool.connection() as conn:
        rows = await (await conn.execute(
            'SELECT "id", "title", "body", "url", "publishedAt", "syncRunId", '
            '  (SELECT s."sourceType" FROM "radar_sync_runs" r '
            '   JOIN "radar_sources" s ON s."id" = r."sourceId" '
            '   WHERE r."id" = "summaries"."syncRunId" LIMIT 1) AS "sourceType" '
            'FROM "summaries" WHERE "source" = \'daily\' '
            'AND "syncRunId" IS NOT NULL '
            'AND "distilledScore" IS NULL '
            'LIMIT 80'
        )).fetchall()

    monitor = ScoringMonitor()
    scored = 0
    for raw in rows:
        row = dict(raw)
        title = str(row["title"])
        body = str(row.get("body", "") or title)
        source_type = str(row.get("sourceType", "rss"))

        profile_id = _SOURCE_PROFILE.get(source_type, "engineering")
        profile = get_profile(profile_id)
        url = str(row.get("url", "") or "")
        published_at = row.get("publishedAt")
        result = await score_with_llm(
            title, body,
            profile=profile,
            source_type=source_type,
            url=url,
            published_at=published_at,
        )
        monitor.record(result)

        async with store.pool.connection() as conn:
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
                    result.total,
                    result.tier,
                    result.must_read,
                    result.profile_id,
                    row["id"],
                ),
            )
        scored += 1
        print(f"  [{scored:3d}] {title[:60]:<60s} | {result.total:4.0f} | {result.tier:10s} | {result.profile_id}")

    alerts = monitor.evaluate()
    print(f"\n  Scored: {monitor.total_count}  Default: {monitor.default_count}  Must-read: {monitor.must_read_count}")
    if alerts:
        print(f"  Alerts: {alerts}")
    await store.close()
    return 0


if __name__ == "__main__":
    exit(asyncio.run(main()))
