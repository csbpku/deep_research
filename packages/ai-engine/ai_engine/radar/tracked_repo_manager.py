"""Tracked repo lifecycle manager.

Post-processing that runs after each radar sync:
1. Record GitHub Trending signals from the DB
2. Update lastActivityAt for tracked repos with activity
3. Auto-archive repos with no activity for 30 days
4. Auto-promote repos with signalCount7d >= 3
5. Sync the github_tracked source config from radar_tracked_repos
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger("ai_engine.radar.tracked_repo_manager")
_PROMOTE_MIN_SIGNALS = 3
_PROMOTE_WINDOW_DAYS = 7
_ARCHIVE_MAX_IDLE_DAYS = 30


def _extract_owner_repo(url: str) -> str | None:
    from urllib.parse import urlsplit
    try:
        u = urlsplit(url.strip())
        if u.netloc.lower() not in ("github.com", "www.github.com"):
            return None
        parts = u.path.strip("/").split("/")
        if len(parts) >= 2 and parts[0] and parts[1]:
            return f"{parts[0].lower()}/{parts[1].lower()}"
    except Exception:
        pass
    return None


async def record_repo_signal(pool: Any, owner_repo: str) -> bool:
    """Record a GitHub Trending signal. New repos start as 'archived' and
    must accumulate _PROMOTE_MIN_SIGNALS signals before promotion."""
    owner_repo = owner_repo.lower().strip()
    async with pool.connection() as conn:
        row = await (await conn.execute(
            'INSERT INTO "radar_tracked_repos" '
            '("ownerRepo", "status", "signalCount7d", "lastSignalAt", "firstSeenAt") '
            "VALUES (%s, 'archived', 1, now(), now()) "
            'ON CONFLICT ("ownerRepo") DO UPDATE SET '
            '"signalCount7d" = "radar_tracked_repos"."signalCount7d" + 1, '
            '"lastSignalAt" = now(), "updatedAt" = now() '
            'RETURNING "id"',
            (owner_repo,),
        )).fetchone()
        return row is not None


async def record_repo_activity(pool: Any, owner_repo: str) -> bool:
    owner_repo = owner_repo.lower().strip()
    async with pool.connection() as conn:
        row = await (await conn.execute(
            'UPDATE "radar_tracked_repos" SET '
            '"lastActivityAt" = now(), "updatedAt" = now() '
            'WHERE "ownerRepo" = %s AND "status" IN (\'tracking\', \'pinned\') '
            'RETURNING "id"',
            (owner_repo,),
        )).fetchone()
        return row is not None


async def auto_archive_inactive(pool: Any, max_idle_days: int = _ARCHIVE_MAX_IDLE_DAYS) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_idle_days)
    async with pool.connection() as conn:
        result = await conn.execute(
            'UPDATE "radar_tracked_repos" SET '
            '"status" = \'archived\', "updatedAt" = now() '
            'WHERE "status" = \'tracking\' '
            'AND "lastActivityAt" IS NOT NULL AND "lastActivityAt" < %s',
            (cutoff,),
        )
        return result.rowcount or 0


async def auto_promote_from_signals(
    pool: Any, min_signals: int = _PROMOTE_MIN_SIGNALS,
) -> int:
    """Promote repos from archived to tracking when signalCount7d >= min_signals."""
    async with pool.connection() as conn:
        result = await conn.execute(
            'UPDATE "radar_tracked_repos" SET '
            '"status" = \'tracking\', "updatedAt" = now() '
            'WHERE "status" = \'archived\' AND "signalCount7d" >= %s',
            (min_signals,),
        )
        return result.rowcount or 0


async def get_active_tracked_repos(pool: Any) -> list[str]:
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            'SELECT "ownerRepo" FROM "radar_tracked_repos" '
            'WHERE "status" IN (\'tracking\', \'pinned\') '
            'ORDER BY "signalCount7d" DESC, "lastActivityAt" DESC'
        )).fetchall()
    return [str(r["ownerRepo"]) for r in rows]


async def _record_signals_from_run(pool: Any, run_id: str) -> int:
    seen: set[str] = set()
    count = 0
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            'SELECT "url" FROM "summaries" WHERE "syncRunId" = %s',
            (run_id,),
        )).fetchall()
    for r in rows:
        owner_repo = _extract_owner_repo(str(r["url"]))
        if owner_repo and owner_repo not in seen:
            seen.add(owner_repo)
            if await record_repo_signal(pool, owner_repo):
                count += 1
    return count


async def _update_activity_from_run(pool: Any, run_id: str) -> int:
    count = 0
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            'SELECT "url" FROM "summaries" WHERE "syncRunId" = %s',
            (run_id,),
        )).fetchall()
    for r in rows:
        owner_repo = _extract_owner_repo(str(r["url"]))
        if owner_repo:
            if await record_repo_activity(pool, owner_repo):
                count += 1
    return count


async def _latest_run_id_for_source(pool: Any, source_type: str) -> str | None:
    async with pool.connection() as conn:
        row = await (await conn.execute(
            'SELECT r."id" FROM "radar_sync_runs" r '
            'JOIN "radar_sources" s ON s."id" = r."sourceId" '
            'WHERE s."sourceType" = %s AND s."enabled" = true '
            'ORDER BY r."createdAt" DESC LIMIT 1',
            (source_type,),
        )).fetchone()
    return str(row["id"]) if row else None


async def run_tracked_repo_postprocessing(
    pool: Any,
    recent_run_ids: dict[str, str] | None = None,
) -> dict[str, int]:
    result: dict[str, int] = {}
    trending_run_id = (recent_run_ids or {}).get("github_trending") or \
        await _latest_run_id_for_source(pool, "github_trending")
    result["signals"] = await _record_signals_from_run(pool, trending_run_id) if trending_run_id else 0
    tracked_run_id = (recent_run_ids or {}).get("github_tracked") or \
        await _latest_run_id_for_source(pool, "github_tracked")
    result["activity_updated"] = await _update_activity_from_run(pool, tracked_run_id) if tracked_run_id else 0
    result["archived"] = await auto_archive_inactive(pool)
    result["promoted"] = await auto_promote_from_signals(pool)
    result["config_synced"] = 1 if await sync_github_tracked_source_config(pool) else 0
    return result


async def sync_github_tracked_source_config(pool: Any) -> bool:
    repos = await get_active_tracked_repos(pool)
    if not repos:
        return False
    async with pool.connection() as conn:
        import json
        row = await (await conn.execute(
            'SELECT "config" FROM "radar_sources" '
            'WHERE "sourceType" = \'github_tracked\' AND "enabled" = true LIMIT 1',
        )).fetchone()
        if not row:
            logger.warning("ai-engine.radar.tracked_repo.no_source")
            return False
        current = dict(row["config"])
        current["repos"] = repos
        current["paginated_repos"] = [
            r for r in repos
            if r in ("vllm-project/vllm", "BerriAI/litellm", "ollama/ollama",
                     "huggingface/transformers", "sgl-project/sglang",
                     "langchain-ai/langchain", "run-llama/llama_index")
        ]
        await conn.execute(
            'UPDATE "radar_sources" SET "config" = %s::jsonb, "updatedAt" = now() '
            'WHERE "sourceType" = \'github_tracked\' AND "enabled" = true',
            (json.dumps(current, ensure_ascii=False),),
        )
    logger.info("ai-engine.radar.tracked_repo.config_synced", extra={"repo_count": len(repos)})
    return True
