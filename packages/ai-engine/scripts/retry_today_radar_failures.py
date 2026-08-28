"""Retry today's latest transient radar source failures.

This preserves the original failed run for auditability and creates new
source-run records for the retry.  Content-policy failures are intentionally
not retried here.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
import os
import sys
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from ai_engine.adapters.base import build_adapter
from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.candidate_postprocessor import score_missing_candidates
from ai_engine.radar.enrichment_worker import run_enrichment_for_pending
from ai_engine.radar.sync_runner import run_radar_pipeline


RETRYABLE_CODES = {
    "URL_FETCH_NETWORK",
    "URL_FETCH_DNS",
    "URL_FETCH_TIMEOUT",
    "WORKER_TIMEOUT",
    "STALE_RUN_REAPED",
}


async def main() -> int:
    load_dotenv()
    dsn = os.environ.get(
        "DATABASE_URL",
        "postgresql://postgres:postgres@localhost:5432/deep_research",
    )
    store = DbJobStore(dsn=dsn)
    await store.open()
    try:
        tz = ZoneInfo("Asia/Shanghai")
        start = datetime.now(tz).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        end = start + timedelta(days=1)
        async with store.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    'SELECT DISTINCT ON ("sourceId") "sourceId", "errorCode" '
                    'FROM "radar_sync_runs" '
                    'WHERE "createdAt" >= %s AND "createdAt" < %s '
                    'ORDER BY "sourceId", "createdAt" DESC',
                    (start, end),
                )
            ).fetchall()

        source_ids = {
            str(dict(row)["sourceId"])
            for row in rows
            if str(dict(row)["errorCode"] or "") in RETRYABLE_CODES
        }
        print(f"latest_failed_sources={len(source_ids)}", flush=True)
        if source_ids:
            result = await run_radar_pipeline(
                store.pool,
                triggered_by="cron",
                adapter=build_adapter(),
                source_ids=source_ids,
            )
            for run in result.sync.runs:
                print(
                    f"source={run.source_id} status={run.status} "
                    f"error={run.error_code or 'none'} new={run.total_new} "
                    f"failed={run.total_failed}",
                    flush=True,
                )
            print(
                f"enriched={result.enriched_count} "
                f"enrichment_error={result.enrichment_error or 'none'}",
                flush=True,
            )

        async with store.pool.connection() as conn:
            score_rows = await (
                await conn.execute(
                    'SELECT "id" FROM "summaries" '
                    'WHERE "source" = \'daily\' '
                    'AND "createdAt" >= %s AND "createdAt" < %s '
                    'AND "distilledScore" IS NULL '
                    'AND length(coalesce("originalMarkdown", "body", \'\')) >= 300 '
                    'AND NOT (coalesce("tags", ARRAY[]::text[]) '
                    '@> ARRAY[\'content_pending\']::text[]) '
                    'ORDER BY "createdAt" ASC',
                    (start, end),
                )
            ).fetchall()
        score_ids = tuple(str(dict(row)["id"]) for row in score_rows)
        scored = await score_missing_candidates(
            store.pool,
            limit=len(score_ids),
            summary_ids=score_ids or None,
            rescore=False,
        )
        print(
            f"today_score_repair_targets={len(score_ids)} "
            f"scored={scored}",
            flush=True,
        )

        async with store.pool.connection() as conn:
            enrichment_rows = await (
                await conn.execute(
                    'SELECT "id" FROM "summaries" '
                    'WHERE "source" = \'daily\' '
                    'AND "createdAt" >= %s AND "createdAt" < %s '
                    'AND "distilledTier" IN (\'collection\', \'deep_read\') '
                    'AND ('
                    '("originalKind" IN (\'rss\', \'web_share\') AND '
                    '("highlights" IS NULL OR '
                    'COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\')) '
                    'OR ("originalKind" = \'github_repo\' AND '
                    'COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\') '
                    'OR ("originalKind" = \'arxiv\' AND '
                    '("arxivAnalysis" IS NULL OR "tldr" IS NULL OR '
                    'COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\'))'
                    ') ORDER BY "createdAt" ASC',
                    (start, end),
                )
            ).fetchall()
        enrichment_ids = tuple(str(dict(row)["id"]) for row in enrichment_rows)
        enriched_today = await run_enrichment_for_pending(
            store.pool,
            limit=len(enrichment_ids),
            summary_ids=enrichment_ids or None,
        )
        print(
            f"today_enrichment_targets={len(enrichment_ids)} "
            f"enriched={enriched_today}",
            flush=True,
        )
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
