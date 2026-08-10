"""Recompute persisted radar scores with the current deterministic policy."""

from __future__ import annotations

import json
import os
from collections import Counter
from typing import Any

import psycopg
from dotenv import dotenv_values

from ai_engine.radar.distilled_scorer import compute_score


def main() -> None:
    env = {**dotenv_values(".env"), **dotenv_values("packages/ai-engine/.env")}
    database_url = os.environ.get("DATABASE_URL") or env.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")

    with psycopg.connect(database_url) as conn:
        rows = conn.execute(
            'SELECT s."id", s."title", s."url", s."originalMarkdown", '
            's."distilledScore", s."tags", rs."sourceType" '
            'FROM "summaries" s '
            'LEFT JOIN "radar_sync_runs" rr ON rr."id" = s."syncRunId" '
            'LEFT JOIN "radar_sources" rs ON rs."id" = rr."sourceId" '
            'WHERE s."source" = \'daily\' AND s."distilledScore" IS NOT NULL'
        ).fetchall()

        tier_counts: Counter[str] = Counter()
        changed = 0
        for row in rows:
            raw = row[4]
            if not isinstance(raw, dict):
                continue
            parsed: dict[str, Any] = {
                **(raw.get("dimensions") or {}),
                **raw,
            }
            score = compute_score(
                parsed,
                source_type=str(row[6] or "rss"),
                url=str(row[2] or ""),
                evidence_text=f"{row[1]}\n{row[3] or ''}",
            )
            tags = [
                tag for tag in row[5]
                if not tag.startswith("tier_") and tag != "must_read"
            ]
            tags.append(f"tier_{score.tier}")
            conn.execute(
                'UPDATE "summaries" SET "distilledScore" = %s::jsonb, '
                '"distilledTotal" = %s, "distilledTier" = %s, '
                '"distilledMustRead" = %s, "tags" = %s, "updatedAt" = now() '
                'WHERE "id" = %s',
                (
                    json.dumps(score.to_dict(), ensure_ascii=False),
                    score.ranking_score,
                    score.tier,
                    score.must_read,
                    tags,
                    row[0],
                ),
            )
            changed += 1
            tier_counts[score.tier] += 1
        conn.commit()
    print(json.dumps({"scored": changed, "tiers": dict(tier_counts)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
