"""Re-score active radar rows without scheduling enrichment work."""
# ruff: noqa: E402

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from typing import Any

from dotenv import load_dotenv

PACKAGE_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PACKAGE_ROOT)

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.candidate_postprocessor import score_missing_candidates
from ai_engine.radar.distilled_scorer import DistilledScore, score_with_llm


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Re-score active radar candidates without enrichment",
    )
    parser.add_argument("--limit", type=int, default=5_000)
    parser.add_argument("--batch-size", type=int, default=10)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--source-type", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    limit = max(1, min(args.limit, 10_000))
    batch_size = max(1, min(args.batch_size, 25))
    concurrency = max(1, min(args.concurrency, 5))
    timeout_seconds = max(30, args.timeout_seconds)
    source_filter = ""
    query_params: tuple[object, ...] = (limit,)
    if args.source_type:
        source_filter = (
            'AND COALESCE(rs."sourceType", CASE '
            'WHEN s."source" = \'user\' THEN \'web_share\' ELSE \'rss\' END) = %s '
        )
        query_params = (args.source_type, limit)

    load_dotenv()
    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        async with store.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    'SELECT s."id" FROM "summaries" s '
                    'LEFT JOIN "radar_sync_runs" rr ON rr."id" = s."syncRunId" '
                    'LEFT JOIN "radar_sources" rs ON rs."id" = rr."sourceId" '
                    'WHERE s."status" IN (\'candidate\', \'published\') '
                    'AND ((s."source" = \'daily\' AND s."syncRunId" IS NOT NULL) '
                    'OR (s."source" = \'user\' AND EXISTS ('
                    'SELECT 1 FROM "share_submissions" sh '
                    'WHERE sh."publishedSummaryId" = s."id" '
                    'AND sh."status" = \'approved\'))) '
                    + source_filter
                    + 'ORDER BY s."createdAt" ASC, s."id" ASC LIMIT %s',
                    query_params,
                )
            ).fetchall()
        ids = tuple(str(dict(row)["id"]) for row in rows)
        source_label = args.source_type or "all"
        print(
            f"active_targets={len(ids)} source_type={source_label} "
            f"batch_size={batch_size} concurrency={concurrency}",
            flush=True,
        )
        if not ids or args.dry_run:
            return 0

        async def bounded_score(
            title: str,
            content: str,
            **kwargs: Any,
        ) -> DistilledScore:
            return await asyncio.wait_for(
                score_with_llm(title, content, **kwargs),
                timeout=timeout_seconds,
            )

        scored_total = 0
        unresolved_total = 0
        for start in range(0, len(ids), batch_size):
            batch = ids[start : start + batch_size]
            scored = await score_missing_candidates(
                store.pool,
                limit=len(batch),
                summary_ids=batch,
                rescore=True,
                suppress_enrichment=True,
                concurrency=concurrency,
                scorer=bounded_score,
            )
            unresolved = len(batch) - scored
            scored_total += scored
            unresolved_total += unresolved
            print(
                f"batch={start // batch_size + 1} targets={len(batch)} "
                f"scored={scored} unresolved={unresolved} "
                f"total_scored={scored_total}",
                flush=True,
            )

        print(
            f"complete targets={len(ids)} scored={scored_total} "
            f"unresolved={unresolved_total}",
            flush=True,
        )
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
