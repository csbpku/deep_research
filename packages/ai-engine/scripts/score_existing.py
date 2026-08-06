"""Score existing radar candidates with Distilled v2 in-place."""
# ruff: noqa: E402
import asyncio
import argparse
import json
import os
import sys
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
from ai_engine.scoring.scoring_profiles import profile_for_source_url

_SOURCE_PROFILE: dict[str, str] = {
    "arxiv": "paper",
    "github": "engineering",
    "github_tracked": "engineering",
    "github_trending": "engineering",
    "github_topic_search": "engineering",
    "huggingface_models": "engineering",
    "devto": "engineering",
    "producthunt": "engineering",
    "rss": "news",
    "hackernews": "news",
    "reddit": "news",
    "lobsters": "news",
    "wechat": "news",
    "vendor_news": "news",
    "web_share": "news",
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
    parser.add_argument("--offset", type=int, default=0,
                        help="Skip this many matching rows (for observable batches)")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=int(os.environ.get("RADAR_RESCORE_CONCURRENCY", "5")),
        help="Maximum concurrent LLM scoring calls",
    )
    parser.add_argument(
        "--date",
        default=None,
        help="Only score candidates for this summary date (YYYY-MM-DD; default: all dates)",
    )
    parser.add_argument(
        "--before-date",
        default=None,
        help="Only score candidates before this summary date (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--summary-id",
        default=None,
        help="Only score one candidate by summary id",
    )
    parser.add_argument(
        "--recalibrate-only",
        action="store_true",
        help="Recompute tiers/effective scores from stored dimensions without LLM calls",
    )
    args = parser.parse_args()

    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()

    # An explicit summary id is an operator request to score that article,
    # including a pending user share that has not entered the approved-share
    # feed yet. Batch runs retain the normal published/approved filter.
    eligibility = (
        '"id" = %s '
        if args.summary_id
        else '( ("source" = \'daily\' AND "syncRunId" IS NOT NULL) '
             'OR ("source" = \'user\' AND "status" IN (\'candidate\', \'published\') '
             'AND EXISTS (SELECT 1 FROM "share_submissions" sh '
             'WHERE sh."publishedSummaryId" = "summaries"."id" '
             'AND sh."status" = \'approved\')) ) '
    )

    async with store.pool.connection() as conn:
        rows = await (await conn.execute(
            'SELECT "id", "title", "body", "url", "publishedAt", "syncRunId", '
            '  "originalMarkdown", '
            '  "distilledScore", "distilledProfile", '
            '  (SELECT s."sourceType" FROM "radar_sync_runs" r '
            '   JOIN "radar_sources" s ON s."id" = r."sourceId" '
            '   WHERE r."id" = "summaries"."syncRunId" LIMIT 1) AS "sourceType" '
            'FROM "summaries" WHERE ' + eligibility
            + 'AND "canonicalUrl" NOT LIKE \'digest://%%\' '
            + ('AND "summaryDate" = %s::date ' if args.date else '')
            + ('AND "summaryDate" < %s::date ' if args.before_date else '')
            + ('' if args.summary_id else '')
            + ('' if args.rescore else 'AND "distilledScore" IS NULL ')
            + ('AND (SELECT s."sourceType" FROM "radar_sync_runs" r '
               'JOIN "radar_sources" s ON s."id" = r."sourceId" '
               'WHERE r."id" = "summaries"."syncRunId" LIMIT 1) = %s '
               if args.source_type else '')
            + 'ORDER BY "id" LIMIT %s OFFSET %s',
            ((args.date,) if args.date else ())
            + ((args.before_date,) if args.before_date else ())
            + ((args.summary_id,) if args.summary_id else ())
            + ((args.source_type,) if args.source_type else ())
            + (args.limit, args.offset)
        )).fetchall()

    concurrency = max(1, args.concurrency)
    score_gate = asyncio.Semaphore(concurrency)

    async def score_row(raw: Any) -> tuple[dict[str, Any], DistilledScore]:
        row = dict(raw)
        title = str(row["title"])
        body = str(row.get("originalMarkdown") or row.get("body") or title)
        source_type = str(row.get("sourceType") or "web_share")

        url = str(row.get("url", "") or "")
        profile, profile_id = profile_for_source_url(source_type, url)
        published_at = row.get("publishedAt")
        stored = row.get("distilledScore")
        if args.recalibrate_only and isinstance(stored, dict):
            dimensions = stored.get("dimensions")
            parsed = dict(dimensions) if isinstance(dimensions, dict) else {}
            parsed["directRelevance"] = stored.get("directRelevance")
            parsed["relevanceEvidence"] = stored.get("relevanceEvidence")
            parsed["scopeBreadth"] = stored.get("scopeBreadth")
            parsed["scopeEvidence"] = stored.get("scopeEvidence")
            parsed["validationBreadth"] = stored.get("validationBreadth")
            parsed["veto"] = stored.get("veto")
            risk_flags = stored.get("riskFlags") or []
            parsed["risk_flag"] = "security_risk" if "security_review_required" in risk_flags else None
            parsed["suspected_repost"] = "suspected_repost" in risk_flags
            result = compute_score(
                parsed,
                profile=profile,
                source_type=source_type,
                evidence_text=f"{title}\n{body}",
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
