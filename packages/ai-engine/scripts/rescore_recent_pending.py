"""Re-score recent radar rows that have complete content but no score."""

from __future__ import annotations

import asyncio
import argparse
from datetime import datetime
import os
from typing import Any

from dotenv import load_dotenv

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.candidate_postprocessor import score_missing_candidates
from ai_engine.radar.distilled_scorer import (
    DimensionScorer,
    DistilledScore,
    score_with_llm,
)
from ai_engine.scoring.scoring_profiles import ScoringProfile


async def _bounded_score(
    title: str,
    content: str,
    *,
    scorer: DimensionScorer | None = None,
    profile: ScoringProfile | None = None,
    source_type: str | None = None,
    url: str | None = None,
    published_at: datetime | None = None,
    structured_signals: dict[str, Any] | None = None,
) -> DistilledScore:
    """Prevent one unavailable provider from hanging the whole repair batch."""
    return await asyncio.wait_for(
        score_with_llm(
            title,
            content,
            scorer=scorer,
            profile=profile,
            source_type=source_type,
            url=url,
            published_at=published_at,
            structured_signals=structured_signals,
        ),
        timeout=90.0,
    )


async def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(
        description="Re-score recent radar rows that have content but no score",
    )
    parser.add_argument("--since-hours", type=int, default=168)
    parser.add_argument("--concurrency", type=int, default=2)
    args = parser.parse_args()
    concurrency = max(1, min(args.concurrency, 8))
    dsn = os.environ["DATABASE_URL"]
    store = DbJobStore(dsn=dsn)
    await store.open()
    try:
        async with store.pool.connection() as conn:
            rows: list[Any] = await (
                await conn.execute(
                    'SELECT DISTINCT sm."id" '
                    'FROM "summaries" sm '
                    'LEFT JOIN "radar_sync_runs" rr ON rr."id" = sm."syncRunId" '
                    'LEFT JOIN "radar_sources" rs ON rs."id" = rr."sourceId" '
                    'WHERE sm."createdAt" >= now() - make_interval(hours => %s) '
                    'AND COALESCE(rs."name", \'\') <> \'WeWe RSS 微信公众号\' '
                    'AND sm."distilledScore" IS NULL '
                    'AND length(coalesce(sm."originalMarkdown", sm.body, \'\')) >= 300 '
                    'AND ((sm."source" = \'daily\' AND sm."syncRunId" IS NOT NULL) '
                    'OR (sm."source" = \'user\' AND sm."status" IN '
                    '(\'candidate\', \'published\') AND EXISTS ('
                    'SELECT 1 FROM "share_submissions" sh '
                    'WHERE sh."publishedSummaryId" = sm."id" '
                    'AND sh."status" = \'approved\'))) '
                    'ORDER BY sm."id"',
                    (args.since_hours,),
                )
            ).fetchall()
        ids = tuple(str(row["id"]) for row in rows)
        print(f"targets={len(ids)}", flush=True)
        if not ids:
            return 0
        rescored = await score_missing_candidates(
            store.pool,
            limit=len(ids),
            summary_ids=ids,
            rescore=True,
            concurrency=concurrency,
            scorer=_bounded_score,
        )
        print(f"rescored={rescored}", flush=True)
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
