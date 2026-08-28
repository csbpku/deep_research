"""Run deep-dive enrichment for pending radar candidates and show counts.

Usage:
  cd packages/ai-engine
  uv run python scripts/run_enrichment.py --limit 50
  uv run python scripts/run_enrichment.py --kind github_repo arxiv rss web_share
  uv run python scripts/run_enrichment.py --summary-id <uuid>
"""
# ruff: noqa: E402
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from typing import Any, cast

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.enrichment_worker import (
    DEFAULT_ENRICHMENT_KINDS,
    run_enrichment_for_pending,
)


async def main() -> int:
    parser = argparse.ArgumentParser(description="Run radar enrichment")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--kind", nargs="*", default=list(DEFAULT_ENRICHMENT_KINDS))
    parser.add_argument("--summary-id", action="append", default=[])
    parser.add_argument(
        "--concurrency",
        type=int,
        default=None,
        help="maximum number of enrichment jobs in flight",
    )
    parser.add_argument(
        "--item-timeout",
        type=float,
        default=None,
        help="per-item timeout in seconds; 0 disables the outer timeout",
    )
    args = parser.parse_args()

    dsn = os.environ.get(
        "DATABASE_URL",
        "postgresql://postgres:postgres@localhost:5432/deep_research",
    )
    store = DbJobStore(dsn=dsn)
    await store.open()
    try:
        before = await _pending_counts(store, tuple(args.kind))
        print("待 enrichment（按 originalKind）:")
        for kind, total in sorted(before.items()):
            print(f"  {kind:<16} {total}")
        print()
        enriched = await run_enrichment_for_pending(
            store.pool,
            limit=args.limit,
            source_kinds=tuple(args.kind),
            summary_ids=tuple(args.summary_id) or None,
            concurrency=args.concurrency,
            item_timeout=args.item_timeout,
            force=bool(args.summary_id),
        )
        print(f"本次成功 enrichment: {enriched}")
        after = await _pending_counts(store, tuple(args.kind))
        print()
        print("完成后剩余（按 originalKind）:")
        for kind, total in sorted(after.items()):
            print(f"  {kind:<16} {total}")
    finally:
        await store.close()
    return 0


async def _pending_counts(store: DbJobStore, kinds: tuple[str, ...]) -> dict[str, int]:
    placeholders = ",".join(["%s"] * len(kinds))
    async with store.pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "originalKind", count(*) AS n FROM "summaries" '
                f'WHERE "originalKind" IN ({placeholders}) '
                'AND "distilledTier" IN (\'collection\', \'deep_read\') '
                'AND ('
                '("originalKind" IN (\'rss\', \'web_share\') '
                'AND "highlights" IS NULL) '
                'OR ("originalKind" = \'github_repo\' '
                'AND "canonicalUrl" NOT LIKE \'%%digest=%%\' '
                'AND ('
                '"originalMeta" IS NULL '
                'OR COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\' '
                'OR COALESCE("originalMeta"->\'zread\'->>\'status\', \'\') '
                'NOT IN (\'complete\', \'partial\', \'failed\')'
                ')) '
                'OR ("originalKind" NOT IN (\'rss\', \'web_share\', \'github_repo\') '
                'AND "originalMeta" IS NULL)'
                ') '
                'AND NOT (COALESCE("tags", ARRAY[]::text[]) '
                '@> ARRAY[\'repo_digest\']::text[]) '
                'AND ("source" = \'daily\' OR "syncRunId" IS NOT NULL OR EXISTS ('
                'SELECT 1 FROM "share_submissions" sh '
                'WHERE sh."publishedSummaryId" = "summaries"."id" '
                'AND sh."status" = \'approved\')) '
                'GROUP BY "originalKind" ORDER BY "originalKind"',
                tuple(kinds),
            )
        ).fetchall()
    return {
        str(cast(Any, r)["originalKind"]): int(cast(Any, r)["n"])
        for r in rows
    }


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
