"""Repair GitHub score/tier/reason persistence drift.

This migration deliberately does not re-run the scorer.  The persisted
``distilledScore`` JSON is the evidence produced by the historical scoring
run; this script only makes the denormalized columns and explanation agree
with that payload.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from typing import Any

from dotenv import load_dotenv

from ai_engine.job_runner.db_store import DbJobStore
_TIER_SCORE_RE = re.compile(r"分层分=([0-9]+(?:\.[0-9]+)?)")
_TIER_RE = re.compile(r"分层=([a-z_]+)")


def _number(value: Any, fallback: float | None = None) -> float | None:
    if isinstance(value, bool):
        return fallback
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _payload_tier_score(payload: dict[str, Any], summary_total: Any) -> float | None:
    value = payload.get("tierScore", payload.get("tier_score"))
    if value is None:
        value = summary_total
    return _number(value)


def _payload_tier(payload: dict[str, Any], summary_tier: Any) -> str:
    return str(payload.get("tier") or summary_tier or "")


def _build_reason(payload: dict[str, Any], tier_score: float, tier: str) -> str:
    version = str(payload.get("version") or "2.0")
    ranking = _number(payload.get("rankingScore", payload.get("ranking_score")))
    ranking_text = (
        f"；排序分={ranking:.1f}/100"
        if ranking is not None and abs(ranking - tier_score) > 0.01
        else ""
    )
    dimensions = payload.get("dimensions")
    dimension_text = ""
    if isinstance(dimensions, dict):
        dimension_text = ", ".join(f"{name}={value}" for name, value in dimensions.items())
    weak_point = str(payload.get("weakPoint", payload.get("weak_point", "")))
    validation = payload.get("validationBreadth", payload.get("validation_breadth"))
    validation_text = f", 验证广度={validation}" if validation is not None else ""
    return (
        f"Distilled v{version}: 分层分={tier_score:.1f}/100"
        f"{ranking_text}；分层={tier}；维度: {dimension_text}{validation_text}；"
        f"弱项: {weak_point}"
    )[:500]


def _rebuild_result(row: dict[str, Any]) -> tuple[dict[str, Any], float, str, str]:
    payload = dict(row["distilledScore"])
    tier_score = _payload_tier_score(payload, row.get("distilledTotal"))
    if tier_score is None:
        raise ValueError("payload has no usable tier score")
    tier = _payload_tier(payload, row.get("distilledTier"))
    if not tier:
        raise ValueError("payload has no usable tier")
    payload["tierScore"] = round(tier_score, 2)
    payload.pop("tier_score", None)
    return payload, round(tier_score, 2), tier, _build_reason(payload, tier_score, tier)


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    load_dotenv()
    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        async with store.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    'SELECT sm."id", sm."title", sm."url", sm."body", '
                    'sm."originalMarkdown", sm."distilledScore", '
                    'sm."distilledTotal", sm."distilledTier", sm."scoreReason", '
                    'rs."sourceType" '
                    'FROM summaries sm '
                    'JOIN radar_sync_runs rr ON rr.id = sm."syncRunId" '
                    'JOIN radar_sources rs ON rs.id = rr."sourceId" '
                    'WHERE sm."distilledScore" IS NOT NULL '
                    'AND rs."sourceType" IN ('
                    '\'github\',\'github_trending\',\'github_topic_search\') '
                    'ORDER BY sm."createdAt" ASC',
                )
            ).fetchall()
        changes: list[tuple[str, dict[str, Any], float, str, str]] = []
        for raw in rows:
            row = dict(raw)
            row["content"] = str(row.get("originalMarkdown") or row.get("body") or "")
            if not isinstance(row.get("distilledScore"), dict):
                continue
            payload, total, tier, reason = _rebuild_result(row)
            stored_reason = str(row.get("scoreReason") or "")
            reason_score = _number(
                (_TIER_SCORE_RE.search(stored_reason) or [None, None])[1]
                if _TIER_SCORE_RE.search(stored_reason)
                else None,
            )
            reason_tier_match = _TIER_RE.search(stored_reason)
            reason_tier = reason_tier_match.group(1) if reason_tier_match else None
            reason_has_same_score = (
                reason_score is not None and abs(reason_score - total) <= 0.05
            )
            reason_has_same_tier = reason_tier == tier
            # Re-write only actual persistence contradictions.  A different
            # punctuation/order/version in an otherwise consistent reason is
            # intentionally left untouched.
            reason_drift = bool(stored_reason) and (
                not reason_has_same_score or not reason_has_same_tier
            )
            payload_drift = (
                abs(float(row.get("distilledTotal") or 0) - total) > 0.01
                or str(row.get("distilledTier") or "") != tier
                or _number(row["distilledScore"].get("tierScore")) is None
                or abs(float(row["distilledScore"].get("tierScore") or 0) - total) > 0.01
            )
            if reason_drift or payload_drift:
                changes.append((str(row["id"]), payload, total, tier, reason))
        print(f"candidates={len(rows)} changes={len(changes)} mode={'apply' if args.apply else 'dry-run'}")
        if not args.apply:
            for summary_id, _payload, total, tier, reason in changes:
                print(f"{summary_id} | {total:.2f} | {tier} | {reason[:120]}")
            return 0
        async with store.pool.connection() as conn:
            for summary_id, payload, total, tier, reason in changes:
                await conn.execute(
                    'UPDATE summaries SET "distilledScore"=%s::jsonb, '
                    '"distilledTotal"=%s, "distilledTier"=%s, "scoreReason"=%s, '
                    '"updatedAt"=now() WHERE id=%s',
                    (json.dumps(payload, ensure_ascii=False), total, tier, reason, summary_id),
                )
            await conn.commit()
        print(f"updated={len(changes)}")
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
