"""Repair and re-score visible radar rows incorrectly persisted at zero.

The scope is intentionally exact:

* synced daily candidates/published rows
* current tier ``noise``
* current total ``0``

GitHub repositories are refreshed through public Zread first and GitHub
README second. Local Zread generation and repo-summary LLM generation are
disabled for this repair.
"""

from __future__ import annotations

import argparse
import asyncio
from collections import Counter
import os
import sys
from typing import Any

from dotenv import load_dotenv

PACKAGE_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PACKAGE_ROOT)
load_dotenv(os.path.join(PACKAGE_ROOT, ".env"))

os.environ["ZREAD_REMOTE_ENABLED"] = "1"
os.environ["ZREAD_CLI_ENABLED"] = "0"
os.environ["GITHUB_REPO_SUMMARY_LLM_ENABLED"] = "0"

from ai_engine.job_runner.db_store import DbJobStore  # noqa: E402
from ai_engine.radar.candidate_postprocessor import score_missing_candidates  # noqa: E402
from ai_engine.radar.enrichment_worker import enrich_github_candidate  # noqa: E402


TARGET_WHERE = (
    '"source" = \'daily\' AND "syncRunId" IS NOT NULL '
    'AND "status" IN (\'candidate\', \'published\') '
    'AND "distilledTier" = \'noise\' '
    'AND COALESCE("distilledTotal", 0) = 0'
)


async def _fetch_targets(
    pool: Any,
    limit: int,
    *,
    ready_pending: bool,
) -> list[dict[str, Any]]:
    where = (
        '"source" = \'daily\' AND "syncRunId" IS NOT NULL '
        'AND "status" IN (\'candidate\', \'published\') '
        'AND "distilledScore" IS NULL '
        'AND "tags" @> ARRAY[\'content_pending\']::text[] '
        'AND length(COALESCE("originalMarkdown", "body", "title", \'\')) >= 300'
        if ready_pending
        else TARGET_WHERE
    )
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id", "title", "canonicalUrl", "url", '
                '"originalKind", length(COALESCE("originalMarkdown", '
                '"body", "title", \'\')) AS "contentChars" '
                'FROM "summaries" WHERE '
                + where
                + ' ORDER BY "createdAt" ASC LIMIT %s',
                (limit,),
            )
        ).fetchall()
    return [dict(row) for row in rows]


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Repair current visible noise rows persisted at score zero",
    )
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--ready-pending",
        action="store_true",
        help="Retry only content_pending rows whose stored body is now complete",
    )
    args = parser.parse_args()

    limit = max(1, min(args.limit, 10_000))
    concurrency = max(1, min(args.concurrency, 5))
    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        rows = await _fetch_targets(
            store.pool,
            limit,
            ready_pending=args.ready_pending,
        )
        ids = tuple(str(row["id"]) for row in rows)
        kind_counts = Counter(str(row.get("originalKind") or "unknown") for row in rows)
        short_count = sum(int(row.get("contentChars") or 0) < 1_000 for row in rows)
        print(
            f"targets={len(rows)} short_before_enrichment={short_count} "
            f"kinds={dict(sorted(kind_counts.items()))}",
            flush=True,
        )
        if not rows or args.dry_run:
            return 0

        placeholders = ",".join(["%s"] * len(ids))
        async with store.pool.connection() as conn:
            await conn.execute(
                'UPDATE "summaries" SET '
                '"distilledScore" = NULL, "distilledTotal" = NULL, '
                '"distilledTier" = NULL, '
                '"distilledProfile" = NULL, "scoreReason" = NULL, '
                '"updatedAt" = now() WHERE "id" IN ('
                + placeholders
                + ')',
                ids,
            )
            await conn.commit()

        gate = asyncio.Semaphore(concurrency)
        github_rows = [
            row for row in rows if row.get("originalKind") == "github_repo"
        ] if not args.ready_pending else []

        async def _enrich(row: dict[str, Any]) -> bool:
            async with gate:
                result = await enrich_github_candidate(
                    store.pool,
                    summary_id=str(row["id"]),
                    canonical_url=str(row.get("canonicalUrl") or row.get("url") or ""),
                )
                return result is not None

        github_results = await asyncio.gather(
            *(_enrich(row) for row in github_rows),
            return_exceptions=True,
        )
        github_enriched = sum(result is True for result in github_results)
        github_failed = len(github_results) - github_enriched
        print(
            f"github_enriched={github_enriched} github_failed={github_failed}",
            flush=True,
        )

        scored = await score_missing_candidates(
            store.pool,
            limit=len(ids),
            summary_ids=ids,
            rescore=True,
            concurrency=concurrency,
        )
        print(f"rescored={scored}", flush=True)

        async with store.pool.connection() as conn:
            result_rows = await (
                await conn.execute(
                    'SELECT COALESCE("distilledTier", \'pending\') AS tier, '
                    'COUNT(*) AS count FROM "summaries" WHERE "id" IN ('
                    + placeholders
                    + ') GROUP BY 1 ORDER BY 1',
                    ids,
                )
            ).fetchall()
            pending = await (
                await conn.execute(
                    'SELECT COUNT(*) AS count FROM "summaries" WHERE "id" IN ('
                    + placeholders
                    + ') AND "tags" @> ARRAY[\'content_pending\']::text[]',
                    ids,
                )
            ).fetchone()
            remaining_zero = await (
                await conn.execute(
                    'SELECT COUNT(*) AS count FROM "summaries" WHERE "id" IN ('
                    + placeholders
                    + ') AND COALESCE("distilledTotal", 0) = 0 '
                    'AND "distilledScore" IS NOT NULL',
                    ids,
                )
            ).fetchone()
        print(
            "tiers="
            + str({
                str(dict(row)["tier"]): int(dict(row)["count"])
                for row in result_rows
            }),
            flush=True,
        )
        print(
            f"content_pending={int(dict(pending or {}).get('count') or 0)} "
            f"persisted_zero={int(dict(remaining_zero or {}).get('count') or 0)}",
            flush=True,
        )
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
