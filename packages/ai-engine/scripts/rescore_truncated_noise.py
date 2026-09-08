"""Re-score rows whose body was clipped by the previous scoring budget.

After raising ``MAX_SCORING_CONTENT_CHARS`` in
:mod:`ai_engine.radar.distilled_scorer` the scorer keeps up to 48k
characters of body instead of 24k. The most affected rows are noise-tier
candidates that were truncated the first time they were scored; this
script finds them and asks the LLM to score them again with the new
budget. It reuses the production scorer (with a 120-second safety
timeout) so newly assigned tiers flow through the normal post-processor
path.

Usage::

      cd packages/ai-engine
      uv run python scripts/rescore_truncated_noise.py --min-length 24000
      uv run python scripts/rescore_truncated_noise.py --include-tier noise skim
      uv run python scripts/rescore_truncated_noise.py --include-tier noise --limit 50
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections import Counter
from datetime import datetime
from typing import Any, Dict

from dotenv import load_dotenv

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PACKAGE_ROOT)
load_dotenv(os.path.join(PACKAGE_ROOT, ".env"))

from ai_engine.job_runner.db_store import DbJobStore  # noqa: E402
from ai_engine.radar.candidate_postprocessor import score_missing_candidates  # noqa: E402
from ai_engine.radar.distilled_scorer import (  # noqa: E402
    DimensionScorer,
    DistilledScore,
    score_with_llm,
)
from ai_engine.scoring.scoring_profiles import ScoringProfile  # noqa: E402


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
    try:
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
            timeout=120.0,
        )
    except Exception as exc:
        print(
            f"  score error {type(exc).__name__}: {str(exc)[:200]}",
            flush=True,
        )
        from ai_engine.radar.distilled_scorer import default_score
        return default_score(profile)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--min-length", type=int, default=24_000,
                        help="minimum originalMarkdown length; defaults to the previous budget")
    parser.add_argument("--include-tier", nargs="*", default=["noise"],
                        help="tiers to re-score; defaults to noise")
    parser.add_argument("--limit", type=int, default=0,
                        help="optional cap on number of rows to rescore")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--summary-id", action="append", default=[],
                        help="restrict re-scoring to specific summary IDs (repeatable)")
    args = parser.parse_args()
    tiers = tuple(args.include_tier)
    concurrency = max(1, min(args.concurrency, 8))
    summary_ids = tuple(args.summary_id)

    dsn = os.environ.get(
        "DATABASE_URL",
        "postgresql://postgres:postgres@localhost:5432/deep_research",
    )
    store = DbJobStore(dsn=dsn)
    await store.open()
    try:
        where_parts = []
        query_params: list[Any] = []
        if summary_ids:
            id_placeholders = ",".join(["%s"] * len(summary_ids))
            where_parts.append(f's."id" IN ({id_placeholders})')
            query_params.extend(summary_ids)
        else:
            placeholders = ",".join(["%s"] * len(tiers))
            where_parts.append(f's."distilledTier" IN ({placeholders})')
            query_params.extend(tiers)
            where_parts.append(
                "length(coalesce(s.\"originalMarkdown\", s.body, '')) >= %s"
            )
            query_params.append(args.min_length)
        where_parts.append(
            "((s.\"source\"='daily' AND s.\"syncRunId\" IS NOT NULL) "
            "OR (s.\"source\"='user' AND s.\"status\" IN "
            "('candidate', 'published') AND EXISTS ("
            'SELECT 1 FROM "share_submissions" sh '
            'WHERE sh."publishedSummaryId" = s."id" '
            "AND sh.\"status\" = 'approved')))"
        )
        sql = (
            'SELECT s."id", s."distilledTier", s."distilledTotal" '
            'FROM "summaries" s '
            "WHERE " + " AND ".join(where_parts)
            + ' ORDER BY length(coalesce(s."originalMarkdown", s.body, \'\')) DESC'
        )
        async with store.pool.connection() as conn:
            rows = await (await conn.execute(sql, tuple(query_params))).fetchall()
        matched_tiers: Counter[str] = Counter()
        for row in rows:
            matched_tiers[str(row["distilledTier"] or "")] += 1
        matched_total = sum(matched_tiers.values())
        if args.limit:
            rows = rows[: args.limit]
        before: Dict[str, str] = {}
        before_total: Dict[str, float | None] = {}
        before_tiers: Counter[str] = Counter()
        ids: list[str] = []
        for row in rows:
            sid = str(row["id"])
            tier = str(row["distilledTier"] or "")
            before[sid] = tier
            total = row["distilledTotal"]
            before_total[sid] = float(total) if total is not None else None
            before_tiers[tier] += 1
            ids.append(sid)
        print(f"selected={len(ids)} min_length={args.min_length} tiers={tiers}", flush=True)
        if matched_total != len(ids):
            print(f"matched={matched_total} (limited to {len(ids)})", flush=True)
            print("matched distribution:", flush=True)
            for tier, count in sorted(matched_tiers.items()):
                print(f"  {tier:<12} {count}", flush=True)
        print("before:", flush=True)
        for tier, count in sorted(before_tiers.items()):
            print(f"  {tier:<12} {count}", flush=True)
        if not ids:
            return 0
        scored = await score_missing_candidates(
            store.pool,
            limit=len(ids),
            summary_ids=tuple(ids),
            rescore=True,
            concurrency=concurrency,
            scorer=_bounded_score,
        )
        print(f"rescored={scored}", flush=True)

        async with store.pool.connection() as conn:
            rows = await (await conn.execute(
                'SELECT "id", "distilledTier", "distilledTotal" '
                'FROM "summaries" WHERE "id" = ANY(%s::uuid[])',
                (ids,),
            )).fetchall()
        after_tiers: Counter[str] = Counter()
        flips: list[tuple[str, str, str, float | None, float | None]] = []
        for row in rows:
            sid = str(row["id"])
            new_tier = str(row["distilledTier"] or "")
            new_total = row["distilledTotal"]
            new_total_f = float(new_total) if new_total is not None else None
            after_tiers[new_tier] += 1
            old_tier = before.get(sid, "?")
            if new_tier != old_tier:
                flips.append((sid, old_tier, new_tier, before_total.get(sid), new_total_f))
        print("after:", flush=True)
        for tier in ("collection", "deep_read", "skim", "noise"):
            old = before_tiers.get(tier, 0)
            new = after_tiers.get(tier, 0)
            if old or new:
                delta = new - old
                print(f"  {tier:<12} {old:>5} -> {new:>5} ({'+' if delta >= 0 else ''}{delta})", flush=True)
        print(f"flips={len(flips)}", flush=True)
        for sid, old_tier, new_tier, old_total, new_total in flips[:30]:
            old_s = f"{old_total:.1f}" if old_total is not None else "-"
            new_s = f"{new_total:.1f}" if new_total is not None else "-"
            print(f"  [{old_tier}->{new_tier}] {old_s}->{new_s}  {sid[:8]}", flush=True)
        if len(flips) > 30:
            print(f"  ... and {len(flips) - 30} more", flush=True)
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
