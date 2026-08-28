"""Remove deep-enrichment drift from skim/noise radar rows.

The raw source body and provenance metadata are preserved. Only AI/deep
presentation payloads and completion markers are removed, because skim/noise
must remain summary-only and must not look enrichment-complete.
"""

from __future__ import annotations

import argparse
import asyncio
import os

from dotenv import load_dotenv

from ai_engine.job_runner.db_store import DbJobStore


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--expected-affected",
        type=int,
        help="Required with --apply; abort if the live target count differs.",
    )
    args = parser.parse_args()
    load_dotenv()
    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        predicate = (
            '"distilledTier" IN (\'skim\', \'noise\') AND ('
            '"repoSummary" IS NOT NULL OR "highlights" IS NOT NULL OR '
            '"arxivAnalysis" IS NOT NULL OR "tldr" IS NOT NULL OR '
            '"sections" IS NOT NULL OR "figures" IS NOT NULL OR '
            '("originalMeta" ?| ARRAY[\'enrichmentVersion\', \'zread\', '
            '\'readingCache\']))'
        )
        async with store.pool.connection() as conn:
            row = await (
                await conn.execute(
                    'SELECT COUNT(*) AS affected, '
                    'COUNT(*) FILTER (WHERE "distilledTier" = \'skim\') AS skim, '
                    'COUNT(*) FILTER (WHERE "distilledTier" = \'noise\') AS noise '
                    'FROM "summaries" WHERE ' + predicate
                )
            ).fetchone()
            counts = dict(row)
            print(
                f"affected={counts['affected']} skim={counts['skim']} "
                f"noise={counts['noise']} apply={args.apply}",
                flush=True,
            )
            if not args.apply:
                return 0
            if args.expected_affected is None:
                raise SystemExit(
                    "--apply requires --expected-affected to prevent a stale "
                    "or broadened cleanup scope"
                )
            if int(counts["affected"]) != args.expected_affected:
                raise SystemExit(
                    "refusing cleanup: expected "
                    f"{args.expected_affected} rows, found {counts['affected']}"
                )
            result = await conn.execute(
                'UPDATE "summaries" SET '
                '"repoSummary" = NULL, "highlights" = NULL, '
                '"arxivAnalysis" = NULL, "tldr" = NULL, "sections" = NULL, '
                '"figures" = NULL, '
                '"originalMeta" = CASE WHEN "originalMeta" IS NULL THEN NULL '
                'ELSE "originalMeta" - \'enrichmentVersion\' - \'zread\' '
                '- \'readingCache\' END, '
                '"updatedAt" = now() WHERE ' + predicate
            )
            await conn.commit()
            print(f"updated={result.rowcount}", flush=True)
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
