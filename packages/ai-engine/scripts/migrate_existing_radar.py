"""Gradually regenerate high-value existing radar entries.

The migration is intentionally bounded and repeatable. It selects old or
incomplete entries with the highest reading value first, forces enrichment,
then re-scores only the rows that were successfully refreshed.

Usage:
    cd packages/ai-engine
    uv run python scripts/migrate_existing_radar.py --limit 200 --concurrency 2
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.job_runner.db_store import DbJobStore  # noqa: E402
from ai_engine.radar.candidate_postprocessor import score_missing_candidates  # noqa: E402
from ai_engine.radar.enrichment_worker import run_enrichment_for_pending  # noqa: E402

MIGRATION_TAG = "migration_queued_v2"


async def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate existing radar entries")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument(
        "--batch-size", type=int, default=8,
        help="Lock and process this many rows at a time",
    )
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument(
        "--item-timeout", type=int, default=600,
        help="Maximum seconds for one enrichment item before continuing",
    )
    parser.add_argument(
        "--no-item-timeout",
        action="store_true",
        help="Do not impose a per-item timeout (intended for long-running Zread retries)",
    )
    parser.add_argument(
        "--stale-lock-minutes", type=int, default=120,
        help="Release migration locks older than this before starting",
    )
    parser.add_argument(
        "--kind",
        choices=("github_repo", "github_other", "github_release", "arxiv", "rss", "web_share"),
        default=None,
        help="Only migrate one original content kind",
    )
    parser.add_argument(
        "--repo",
        action="append",
        default=[],
        help="Only migrate the named GitHub owner/repo; may be repeated",
    )
    parser.add_argument(
        "--zread-timeout",
        type=int,
        default=None,
        help="Override ZREAD_CLI_TIMEOUT_SECONDS for this bounded batch",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--force-all-quality",
        action="store_true",
        help="Rebuild every collection/deep_read row, including enrichmentVersion=2.0 rows",
    )
    parser.add_argument(
        "--all-records",
        action="store_true",
        help="Include every synced daily record, including skim/noise and non-candidate statuses",
    )
    parser.add_argument(
        "--retry-zread-failed",
        action="store_true",
        help="Retry high-value GitHub repos whose Zread status is failed or missing",
    )
    args = parser.parse_args()
    limit = max(1, min(10_000, args.limit))
    batch_size = max(1, min(25, args.batch_size))
    item_timeout = 0 if args.no_item_timeout else max(30, args.item_timeout)

    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        # A killed terminal/process must not permanently hide candidates.
        # Only release this migration's own lease, and keep content_pending
        # untouched so failed fetches remain visible to the normal retry path.
        async with store.pool.connection() as conn:
            await conn.execute(
                'UPDATE "summaries" SET "tags" = array_remove("tags", %s), '
                '"updatedAt" = now() WHERE "tags" @> ARRAY[%s]::text[] '
                'AND "updatedAt" < now() - make_interval(mins => %s)',
                (MIGRATION_TAG, MIGRATION_TAG, max(30, args.stale_lock_minutes)),
            )
            await conn.commit()
        if args.zread_timeout is not None:
            os.environ["ZREAD_CLI_TIMEOUT_SECONDS"] = str(max(0, args.zread_timeout))
        kind_filter = 'AND "originalKind" = %s ' if args.kind else ''
        repo_values = tuple(
            value.strip().strip('/').lower()
            for value in args.repo
            if value.strip().strip('/')
        )
        repo_filter = ''
        repo_params: tuple[object, ...] = ()
        if repo_values:
            # Canonical URLs in older rows are not uniform (www, trailing
            # slash, .git, or an imported source URL). Compare the normalized
            # GitHub path so --repo never silently skips a requested repo.
            repo_filter = (
                "AND regexp_replace("
                "regexp_replace(lower(trim(trailing '/' from \"canonicalUrl\")), "
                "'^https?://(www\\.)?github\\.com/', ''), '\\.git$', ''"
                ") IN (" + ','.join(['%s'] * len(repo_values)) + ') '
            )
            repo_params = repo_values
        migration_filter = (
            '' if args.force_all_quality or args.retry_zread_failed else
            'AND COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') <> \'2.0\' '
        )
        zread_filter = (
            'AND "originalKind" = \'github_repo\' '
            'AND (COALESCE("originalMeta"->\'zread\'->>\'status\', \'\') = \'failed\' '
            'OR COALESCE("originalMeta"->\'zread\'->>\'provider\', \'\') = \'github-readme-fallback\' '
            'OR NOT (COALESCE("originalMeta", \'{}\'::jsonb) ? \'zread\')) '
            if args.retry_zread_failed else ''
        )
        scope_filter = (
            'AND "source" = \'daily\' AND "syncRunId" IS NOT NULL '
            if args.all_records
            else 'AND "source" = \'daily\' AND "syncRunId" IS NOT NULL '
            'AND "status" IN (\'candidate\', \'published\') '
            'AND "distilledTier" IN (\'collection\', \'deep_read\') '
        )
        query_params: tuple[object, ...] = ((args.kind,) if args.kind else ()) + repo_params + (limit,)
        async with store.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    'SELECT "id", "title", "originalKind", "distilledTier", '
                    '"distilledTotal" FROM "summaries" '
                    'WHERE 1=1 '
                    + scope_filter +
                    'AND "originalKind" IN (\'github_repo\', \'github_other\', \'github_release\', '
                    '\'arxiv\', \'rss\', \'web_share\') '
                    'AND NOT ("tags" @> ARRAY[\'migration_queued_v2\']::text[]) '
                    + kind_filter +
                    repo_filter +
                    zread_filter +
                    migration_filter +
                    'ORDER BY CASE "distilledTier" '
                    'WHEN \'collection\' THEN 0 WHEN \'deep_read\' THEN 1 '
                    'WHEN \'skim\' THEN 2 ELSE 3 END, '
                    'COALESCE("distilledTotal", 0) DESC, "createdAt" ASC LIMIT %s',
                    query_params,
                )
            ).fetchall()
        row_dicts = [dict(raw_row) for raw_row in rows]
        ids = tuple(str(row["id"]) for row in row_dicts)
        if not ids:
            print("No existing radar entries need migration.")
            return 0
        for row in row_dicts:
            print(
                f"  {row['id']} | {row['distilledTier'] or 'pending':10s} | "
                f"{row['originalKind'] or 'unknown':14s} | {str(row['title'])[:80]}"
            )
        if args.dry_run:
            return 0

        enriched_total = 0
        rescored_total = 0
        for offset in range(0, len(ids), batch_size):
            batch_ids = ids[offset:offset + batch_size]
            placeholders = ",".join(["%s"] * len(batch_ids))
            print(
                f"Starting batch {offset // batch_size + 1} "
                f"({len(batch_ids)} rows)", flush=True,
            )
            async with store.pool.connection() as conn:
                await conn.execute(
                    'UPDATE "summaries" SET '
                    '"tags" = array_append(array_remove(array_remove("tags", \'content_pending\'), '
                    '\'migration_queued_v2\'), %s), '
                    '"originalMarkdown" = NULL, "originalMeta" = NULL, '
                    '"highlights" = NULL, "repoSummary" = NULL, "arxivAnalysis" = NULL, '
                    '"tldr" = NULL, "sections" = NULL, "figures" = NULL, "authors" = ARRAY[]::text[], '
                    '"updatedAt" = now() WHERE "id" IN (' + placeholders + ')',
                    (MIGRATION_TAG, *batch_ids),
                )
                await conn.commit()
            enriched = 0
            rescored = 0
            try:
                enriched = await run_enrichment_for_pending(
                    store.pool,
                    limit=len(batch_ids),
                    summary_ids=batch_ids,
                    concurrency=max(1, args.concurrency),
                    force=True,
                    item_timeout=item_timeout,
                )
                rescored = await score_missing_candidates(
                    store.pool,
                    limit=len(batch_ids),
                    summary_ids=batch_ids,
                    rescore=True,
                    concurrency=max(1, args.concurrency),
                )
            except Exception as exc:  # isolate one batch from the migration
                print(
                    f"Batch failed: {type(exc).__name__}: {exc}",
                    flush=True,
                )
            finally:
                async with store.pool.connection() as conn:
                    await conn.execute(
                        'UPDATE "summaries" SET "tags" = array_remove("tags", %s), '
                        '"updatedAt" = now() WHERE "id" IN (' + placeholders + ')',
                        (MIGRATION_TAG, *batch_ids),
                    )
                    await conn.commit()
            enriched_total += enriched
            rescored_total += rescored
            print(
                f"Finished batch: enriched={enriched} rescored={rescored} "
                f"overall={offset + len(batch_ids)}/{len(ids)}",
                flush=True,
            )
        print(
            f"Migrated: {len(ids)}  enriched: {enriched_total}  "
            f"rescored: {rescored_total}", flush=True,
        )
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
