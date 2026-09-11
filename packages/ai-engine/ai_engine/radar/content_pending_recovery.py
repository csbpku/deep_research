"""Recover radar candidates whose source capture was only a fetch shell.

Source sync intentionally does not ask the scorer to interpret bot-check pages,
paywall stubs, or empty metadata fallbacks.  Those rows need a bounded source
retry before they can become scoreable; otherwise the normal LLM recovery loop
will keep reporting them as pending without ever changing their content.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from ai_engine.radar.candidate_postprocessor import score_missing_candidates
from ai_engine.radar.enrichment_worker import run_enrichment_for_pending


def _env_int(name: str, default: int, *, minimum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, value)


@dataclass(frozen=True, slots=True)
class ContentPendingRecoveryResult:
    selected: int = 0
    enriched: int = 0
    scored: int = 0

    def to_dict(self) -> dict[str, int]:
        return {
            "selected": self.selected,
            "enriched": self.enriched,
            "scored": self.scored,
        }


async def _select_ids(pool: Any, *, limit: int) -> tuple[str, ...]:
    max_attempts = _env_int(
        "RADAR_CONTENT_RECOVERY_MAX_ATTEMPTS", 3, minimum=1,
    )
    cooldown_minutes = _env_int(
        "RADAR_CONTENT_RECOVERY_COOLDOWN_MINUTES", 15, minimum=1,
    )
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT s."id" FROM "summaries" s '
                'WHERE s."source" = \'daily\' '
                'AND s."syncRunId" IS NOT NULL '
                'AND s."distilledScore" IS NULL '
                'AND s."tags" @> ARRAY[\'content_pending\']::text[] '
                'AND COALESCE(s."enrichmentStatus", \'\') <> \'running\' '
                'AND COALESCE(s."enrichmentAttempts", 0) < %s '
                'AND s."updatedAt" < now() - make_interval(mins => %s) '
                'ORDER BY s."updatedAt" ASC, s."createdAt" ASC LIMIT %s',
                (max_attempts, cooldown_minutes, max(1, limit)),
            )
        ).fetchall()
    return tuple(str(row["id"]) for row in rows)


async def recover_content_pending_candidates(
    pool: Any,
    *,
    limit: int | None = None,
    concurrency: int = 1,
) -> ContentPendingRecoveryResult:
    """Refetch a bounded batch, then score only successfully captured content."""
    batch_limit = limit or _env_int(
        "RADAR_CONTENT_RECOVERY_LIMIT", 5, minimum=1,
    )
    summary_ids = await _select_ids(pool, limit=batch_limit)
    if not summary_ids:
        return ContentPendingRecoveryResult()

    enriched = await run_enrichment_for_pending(
        pool,
        limit=len(summary_ids),
        summary_ids=summary_ids,
        concurrency=max(1, min(concurrency, 2)),
        force=True,
        item_timeout=max(
            30,
            _env_int("RADAR_CONTENT_RECOVERY_ITEM_TIMEOUT_SECONDS", 300, minimum=30),
        ),
    )
    scored = await score_missing_candidates(
        pool,
        limit=len(summary_ids),
        summary_ids=summary_ids,
        concurrency=max(1, min(concurrency, 2)),
    )
    return ContentPendingRecoveryResult(
        selected=len(summary_ids),
        enriched=enriched,
        scored=scored,
    )


__all__ = [
    "ContentPendingRecoveryResult",
    "recover_content_pending_candidates",
]
