"""Repair the current radar retryable enrichment backlog.

The first pass is deterministic and never calls the network:

* reconcile rows whose persisted reader snapshot is already complete;
* rebuild legacy GitHub reader markdown from complete Zread pages.

An optional second pass re-runs the remaining source enrichers with an
explicit bounded timeout. Partial or failed source results remain retryable.
"""
# ruff: noqa: E402

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.enrichment_contract import enrichment_review_reset_assignments
from ai_engine.radar.enrichment_worker import (
    _zread_pages_complete,
    _zread_scoring_markdown,
    run_enrichment_for_pending,
)
from ai_engine.radar.reader_quality import load_and_persist_reader_quality


def _as_dict(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


async def _retryable_rows(pool: Any) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id", "originalKind", "originalMarkdown", '
                '"originalMeta", "originalSha256", "readerQualityStatus", '
                '"readerQualityDetails" '
                'FROM "summaries" '
                'WHERE "distilledTier" IN (\'collection\', \'deep_read\') '
                'AND "enrichmentStatus" = \'retryable\' '
                'ORDER BY "enrichmentNextRetryAt" ASC NULLS FIRST, "createdAt" ASC'
            )
        ).fetchall()
    return [dict(row) for row in rows]


async def _mark_ready(pool: Any, summary_id: str) -> bool:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"enrichmentStatus" = \'ready\', '
            '"enrichmentLockedBy" = NULL, '
            '"enrichmentLeaseExpiresAt" = NULL, '
            '"enrichmentHeartbeatAt" = NULL, '
            '"enrichmentClaimId" = NULL, '
            '"enrichmentNextRetryAt" = NULL, '
            '"enrichmentErrorCode" = NULL, '
            '"enrichmentErrorMessage" = NULL, '
            '"updatedAt" = now() '
            'WHERE "id" = %s AND "enrichmentStatus" = \'retryable\'',
            (summary_id,),
        )
    return getattr(cursor, "rowcount", 1) > 0


async def _rebuild_legacy_github(
    pool: Any,
    row: dict[str, Any],
) -> bool:
    meta = _as_dict(row.get("originalMeta"))
    zread = _as_dict(meta.get("zread"))
    quality_details = _as_dict(row.get("readerQualityDetails"))
    if (
        row.get("originalKind") != "github_repo"
        or quality_details.get("reason") != "legacy_reader_truncation"
        or not _zread_pages_complete(zread)
    ):
        return False

    markdown = _zread_scoring_markdown(zread, None).strip()
    if not markdown:
        return False

    meta["readerMarkdownComplete"] = True
    meta["readerMarkdownBytes"] = len(markdown.encode("utf-8"))
    markdown_sha256 = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMeta" = %s::jsonb, '
            '"originalMarkdown" = %s, '
            '"originalSha256" = %s, '
            '"originalBytes" = %s, '
            f'{enrichment_review_reset_assignments()}, '
            '"updatedAt" = now() '
            'WHERE "id" = %s AND "enrichmentStatus" = \'retryable\' '
            'AND "originalSha256" IS NOT DISTINCT FROM %s',
            (
                json.dumps(meta, ensure_ascii=False),
                markdown,
                markdown_sha256,
                len(markdown.encode("utf-8")),
                str(row["id"]),
                row.get("originalSha256"),
            ),
        )
    if getattr(cursor, "rowcount", 1) == 0:
        return False
    quality = await load_and_persist_reader_quality(
        pool,
        summary_id=str(row["id"]),
    )
    return quality.ready and await _mark_ready(pool, str(row["id"]))


async def _deterministic_repair(pool: Any) -> dict[str, int]:
    reconciled = 0
    rebuilt = 0
    rows = await _retryable_rows(pool)
    for row in rows:
        summary_id = str(row["id"])
        meta = _as_dict(row.get("originalMeta"))
        quality_details = _as_dict(row.get("readerQualityDetails"))
        if (
            row.get("readerQualityStatus") == "ready"
            and meta.get("enrichmentVersion") == "2.0"
            and quality_details.get("contentSha256") == row.get("originalSha256")
        ):
            if await _mark_ready(pool, summary_id):
                reconciled += 1
            continue
        if await _rebuild_legacy_github(pool, row):
            rebuilt += 1
    return {"reconciled": reconciled, "rebuilt": rebuilt}


async def _remaining_ids(
    pool: Any,
    *,
    include_manual: bool = False,
) -> list[str]:
    statuses = "'retryable', 'manual'" if include_manual else "'retryable'"
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id" FROM "summaries" '
                'WHERE "distilledTier" IN (\'collection\', \'deep_read\') '
                f'AND "enrichmentStatus" IN ({statuses}) '
                'ORDER BY "enrichmentNextRetryAt" ASC NULLS FIRST, "createdAt" ASC'
            )
        ).fetchall()
    return [str(row["id"]) for row in rows]


async def main() -> int:
    parser = argparse.ArgumentParser(description="Repair retryable radar enrichment")
    parser.add_argument(
        "--external",
        action="store_true",
        help="also rerun remaining source fetchers and Zread",
    )
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument(
        "--item-timeout",
        type=float,
        default=900.0,
        help="per-source timeout in seconds; 0 disables the outer timeout",
    )
    parser.add_argument(
        "--summary-id",
        action="append",
        dest="summary_ids",
        help="repair only this retryable summary; may be passed more than once",
    )
    parser.add_argument(
        "--include-manual",
        action="store_true",
        help="allow explicitly selected manual rows to re-enter enrichment",
    )
    args = parser.parse_args()

    dsn = os.environ.get(
        "DATABASE_URL",
        "postgresql://postgres:postgres@localhost:5432/deep_research",
    )
    store = DbJobStore(dsn=dsn)
    await store.open()
    try:
        deterministic = await _deterministic_repair(store.pool)
        remaining = await _remaining_ids(
            store.pool,
            include_manual=args.include_manual,
        )
        if args.summary_ids:
            requested = set(args.summary_ids)
            remaining = [summary_id for summary_id in remaining if summary_id in requested]
        print(
            "deterministic:",
            json.dumps(deterministic, ensure_ascii=False, sort_keys=True),
        )
        print(f"remaining_retryable: {len(remaining)}")
        if args.external and remaining:
            enriched = 0
            for index, summary_id in enumerate(remaining, start=1):
                completed = await run_enrichment_for_pending(
                    store.pool,
                    limit=1,
                    summary_ids=(summary_id,),
                    concurrency=max(1, args.concurrency),
                    item_timeout=args.item_timeout,
                    force=True,
                )
                enriched += completed
                print(
                    f"external_progress: {index}/{len(remaining)} "
                    f"id={summary_id} successful={completed}",
                    flush=True,
                )
            print(f"external_successful_enrichment: {enriched}")
            print(
                "remaining_retryable:",
                len(
                    await _remaining_ids(
                        store.pool,
                        include_manual=args.include_manual,
                    )
                ),
            )
    finally:
        await store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
