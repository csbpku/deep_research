"""已有热点主题刷新入口。

雷达流水线完成后或手动触发时，确保预设主题存在，再委托
topic_refresh_worker 刷新已有主题及候选关联，不生成主题提议。
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any

from ai_engine.radar.topic_refresh_worker import ensure_topic_presets

logger = logging.getLogger("ai_engine.radar.topic_worker")

ALLOWED_TIERS = frozenset({"collection", "deep_read"})


def _topic_slug(name: str) -> str:
    """Return the stable canonical slug used for reconciliation and upsert."""
    return re.sub(r"[^a-z0-9一-鿿]+", "-", name.lower()).strip("-")[:120]


async def run_topic_aggregation(
    pool: Any,
    *,
    now: datetime | None = None,
) -> dict[str, int]:
    """Ensure presets and refresh existing topics without creating proposals."""
    from ai_engine.radar.topic_refresh_worker import refresh_existing_topics
    presets_created = await ensure_topic_presets(pool)
    result = await refresh_existing_topics(pool, now=now)
    logger.info("ai-engine.radar.topic.refresh_done", extra=result)
    return {
        "topics_created": presets_created,
        "candidates_linked": result["candidates_linked"],
        "proposals_created": 0,
        "proposal_candidates_linked": 0,
        "proposal_failed": 0,
        "stale_removed": result["candidates_removed"],
        "topics_retired": 0,
        "topics_refreshed": result["topics_refreshed"],
    }


__all__ = ["run_topic_aggregation"]
