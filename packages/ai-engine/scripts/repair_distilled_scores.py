"""Repair missing Distilled scores without allowing one provider to hang the batch."""

from __future__ import annotations

import argparse
import asyncio
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
    repair_content_chars = int(
        os.environ.get("RADAR_REPAIR_CONTENT_CHARS", "0") or "0"
    )
    if repair_content_chars > 0 and len(content) > repair_content_chars:
        content = content[:repair_content_chars]
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
        timeout=60.0,
    )


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument(
        "--summary-id",
        action="append",
        dest="summary_ids",
        help="Repair only the explicitly listed summary ID(s); repeatable.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=1,
        help="Persist each batch before starting the next one (default: 1)",
    )
    args = parser.parse_args()

    load_dotenv()
    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        async with store.pool.connection() as conn:
            target_filter = ""
            target_params: tuple[str, ...] = ()
            if args.summary_ids:
                placeholders = ",".join(["%s"] * len(args.summary_ids))
                target_filter = f'AND sm."id" IN ({placeholders}) '
                target_params = tuple(args.summary_ids)
            rows = await (
                await conn.execute(
                    'SELECT sm."id" '
                    'FROM summaries sm '
                    'JOIN radar_sync_runs rr ON rr.id = sm."syncRunId" '
                    'JOIN radar_sources rs ON rs.id = rr."sourceId" '
                    'WHERE sm."distilledScore" IS NULL '
                    'AND rs.enabled = true '
                    'AND rs.name <> \'WeWe RSS 微信公众号\' '
                    'AND length(coalesce(sm."originalMarkdown", sm.body, \'\')) >= 300 '
                    + target_filter +
                    'ORDER BY sm."createdAt" ASC LIMIT %s',
                    (*target_params, max(1, min(args.limit, 1_000))),
                )
            ).fetchall()
        ids = tuple(str(dict(row)["id"]) for row in rows)
        print(f"targets={len(ids)}", flush=True)
        if not ids:
            return 0
        batch_size = max(1, min(args.batch_size, 10))
        total_scored = 0
        total_unresolved = 0
        for start in range(0, len(ids), batch_size):
            batch_ids = ids[start : start + batch_size]
            scored = await score_missing_candidates(
                store.pool,
                limit=len(batch_ids),
                summary_ids=batch_ids,
                rescore=True,
                concurrency=max(1, min(args.concurrency, 5)),
                scorer=_bounded_score,
            )
            total_scored += scored
            total_unresolved += len(batch_ids) - scored
            print(
                f"batch={start // batch_size + 1} targets={len(batch_ids)} "
                f"scored={scored} unresolved={len(batch_ids) - scored}",
                flush=True,
            )
        print(
            f"scored={total_scored} unresolved={total_unresolved}",
            flush=True,
        )
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
