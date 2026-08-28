"""Backfill the score that actually determines each persisted radar tier.

The scorer historically persisted ``rankingScore`` into ``distilledTotal``
even though tier assignment used a separate bounded score. This migration
reconstructs that tier score from the stored score payload, preserving the
already assigned tier when an editorial override was involved.
"""

from __future__ import annotations

import argparse
import asyncio
from collections import Counter
import json
import os
import sys
from typing import Any

from dotenv import load_dotenv

PACKAGE_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PACKAGE_ROOT)
load_dotenv(os.path.join(PACKAGE_ROOT, ".env"))

from ai_engine.job_runner.db_store import DbJobStore  # noqa: E402
from ai_engine.scoring.scoring_profiles import get_profile  # noqa: E402


def _number(value: Any, fallback: float = 0.0) -> float:
    if isinstance(value, bool):
        return fallback
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def reconstruct_tier_score(payload: dict[str, Any], tier: str, profile_id: str) -> float:
    """Reconstruct the historical tier score without fabricating downgrades.

    Current scoring has two upward editorial overrides: practical papers may
    be raised to deep_read and collection-ready items may be raised to
    collection. Older rows can also reflect thresholds that have since moved,
    so a persisted lower tier must not cause the numerical score to be lowered.
    """
    profile = get_profile(profile_id)
    total = _number(payload.get("total"))
    repo_bonus = _number(
        payload.get("repoSignalBonus", payload.get("repo_signal_bonus")),
    )
    ranking = _number(
        payload.get(
            "rankingScore",
            payload.get(
                "ranking_score",
                payload.get(
                    "effectiveTotal",
                    payload.get("effective_total", total),
                ),
            ),
        ),
        total,
    )
    score = min(total + repo_bonus, ranking)

    tier_rank = {"noise": 0, "skim": 1, "deep_read": 2, "collection": 3}
    if score >= profile.tier_collection:
        computed_tier = "collection"
    elif score >= profile.tier_deep_read:
        computed_tier = "deep_read"
    elif score >= profile.tier_skim:
        computed_tier = "skim"
    else:
        computed_tier = "noise"

    if tier_rank.get(tier, 0) <= tier_rank[computed_tier]:
        return round(max(0.0, min(score, 100.0)), 2)
    if tier == "collection":
        score = max(score, profile.tier_collection)
    elif tier == "deep_read":
        score = max(score, profile.tier_deep_read)
    elif tier == "skim":
        score = max(score, profile.tier_skim)
    return round(max(0.0, min(score, 100.0)), 2)


def build_reason(payload: dict[str, Any], tier_score: float, tier: str) -> str:
    version = str(payload.get("version") or "2.0")
    ranking = payload.get("rankingScore", payload.get("ranking_score"))
    ranking_score = _number(ranking, tier_score)
    ranking_text = (
        f"；排序分={ranking_score:.1f}/100"
        if ranking is not None and ranking_score != tier_score
        else ""
    )
    dimensions = payload.get("dimensions")
    dimension_text = ""
    if isinstance(dimensions, dict):
        dimension_text = ", ".join(
            f"{name}={value}" for name, value in dimensions.items()
        )
    weak_point = str(
        payload.get("weakPoint", payload.get("weak_point", "")),
    )
    return (
        f"Distilled v{version}: 分层分={tier_score:.1f}/100"
        f"{ranking_text}；分层={tier}；维度: {dimension_text}；"
        f"弱项: {weak_point}"
    )[:500]


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill persisted tierScore and align distilledTotal",
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int, default=10_000)
    args = parser.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is required")

    store = DbJobStore(dsn=dsn)
    await store.open()
    try:
        async with store.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    'SELECT "id", "title", "distilledScore", "distilledTotal", '
                    '"distilledTier", "distilledProfile" FROM "summaries" '
                    'WHERE "distilledScore" IS NOT NULL '
                    'AND "distilledTier" IS NOT NULL '
                    'ORDER BY "createdAt" ASC LIMIT %s',
                    (max(1, min(args.limit, 100_000)),),
                )
            ).fetchall()

        changes: list[tuple[str, dict[str, Any], float, str, str]] = []
        transitions: Counter[str] = Counter()
        for raw_row in rows:
            row = dict(raw_row)
            payload = row.get("distilledScore")
            if not isinstance(payload, dict):
                continue
            tier = str(row.get("distilledTier") or payload.get("tier") or "noise")
            profile_id = str(
                row.get("distilledProfile") or payload.get("profile") or "engineering",
            )
            tier_score = reconstruct_tier_score(payload, tier, profile_id)
            old_total = _number(row.get("distilledTotal"), -1.0)
            old_tier_score = payload.get("tierScore", payload.get("tier_score"))
            if old_tier_score is not None and old_total == tier_score:
                continue
            payload["tierScore"] = tier_score
            payload.pop("tier_score", None)
            reason = build_reason(payload, tier_score, tier)
            changes.append((str(row["id"]), payload, tier_score, reason, str(row["title"])))
            transitions[f"{old_total:.2f}→{tier_score:.2f}"] += 1

        print(
            f"rows={len(rows)} changes={len(changes)} mode="
            f"{'apply' if args.apply else 'dry-run'}",
        )
        for summary_id, _payload, tier_score, _reason, title in changes[:20]:
            print(f"{summary_id} | {tier_score:6.2f} | {title[:90]}")
        if transitions:
            print("top_transitions=" + json.dumps(transitions.most_common(15), ensure_ascii=False))

        if not args.apply or not changes:
            return 0

        async with store.pool.connection() as conn:
            for summary_id, payload, tier_score, reason, _title in changes:
                await conn.execute(
                    'UPDATE "summaries" SET "distilledScore" = %s::jsonb, '
                    '"distilledTotal" = %s, "scoreReason" = %s, '
                    '"updatedAt" = now() WHERE "id" = %s',
                    (
                        json.dumps(payload, ensure_ascii=False),
                        tier_score,
                        reason,
                        summary_id,
                    ),
                )
            await conn.commit()
        print(f"updated={len(changes)}")
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
