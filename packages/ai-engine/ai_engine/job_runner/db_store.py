"""DB-backed JobStore — Week 2 implementation (was Week 5; promoted by W1 review).

This module talks to two job tables via a shared `AsyncConnectionPool`:

- `ai_research_jobs` (AI research + summary jobs)
- `content_import_jobs` (file import jobs, Week 3+)

Both tables share the same lease semantics (lockedBy / leaseExpiresAt /
heartbeatAt / attempts), so the store is parameterised by `table_name`.

IMPORTANT: Column names MUST match Prisma's camelCase conventions as they
appear in the actual Postgres tables. Prisma maps `model` fields 1:1; we
use double-quoted identifiers everywhere to handle the mixed case.

W2 review 修正:
- 行映射:psycopg dict_row → 直接 dict(row),不再 hasattr(_fields) 探测
- mark_terminal 加 contract:succeeded 必传真 draft_research_id;partial 不传
- 删 sentinel 假 sources:caller 必须 record_progress 写真 sources
- get_row 让 HTTP 层不再依赖 InMemoryJobStore 私有 _Row
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, cast

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ai_engine.adapters.base import AdapterSource
from ai_engine.contracts.errors import AdapterError
from ai_engine.contracts.states import PARTIAL_MIN_SOURCES, AiJobStatus, AiJobStep
from ai_engine.job_runner.models import (
    HeartbeatResult,
    JobLease,
    JobSnapshot,
    LeaseLostError,
    ReviewWorkItem,
)
from ai_engine.job_runner.store import JobRowView, JobStore

logger = logging.getLogger("ai_engine.job_runner.db_store")

AI_TABLE = "ai_research_jobs"
IMPORT_TABLE = "content_import_jobs"
SHARED_TABLES: tuple[str, ...] = (AI_TABLE, IMPORT_TABLE)

# W2 review 修正:InMemoryJobStore 测试路径(无真 DB)succeeded 时,
# 工厂把 fake draft id 写到这里,让 runner 拿到非 None id。生产不依赖。
_drafts_for_tests: dict[str, dict[str, object]] = {}

# AI 调研默认把雷达里已沉淀的深读材料作为内部语料（collection/deep_read）。
# 只取最近窗口内有限条，避免把整个历史库塞进调研 prompt。
AUTO_RADAR_TIERS = ("collection", "deep_read")
AUTO_RADAR_LIMIT = 20
AUTO_RADAR_DAYS = 30


def _review_sources(value: object) -> tuple[AdapterSource, ...]:
    """Decode the persisted fetched-source snapshot for the review worker."""
    if not isinstance(value, list):
        return ()
    sources: list[AdapterSource] = []
    for raw in value:
        if not isinstance(raw, dict):
            continue
        source_ref = raw.get("source_ref") or raw.get("sourceRef")
        canonical = raw.get("canonical_key") or raw.get("canonicalKey")
        if not isinstance(source_ref, dict) or not isinstance(canonical, str):
            continue
        clean_ref = {
            str(key): item
            for key, item in source_ref.items()
            if isinstance(item, (str, bool))
        }
        if not clean_ref:
            continue
        step = raw.get("step_captured") or raw.get("stepCaptured") or "search"
        if step not in {"plan", "search", "compress", "analyze", "write"}:
            step = "search"
        score = raw.get("score")
        sources.append(
            AdapterSource(
                source_ref=clean_ref,
                canonical_key=canonical,
                title=raw.get("title") if isinstance(raw.get("title"), str) else None,
                snippet=raw.get("snippet") if isinstance(raw.get("snippet"), str) else None,
                score=score if isinstance(score, (int, float)) and not isinstance(score, bool) else None,
                step_captured=cast(AiJobStep, step),
                is_accessible=bool(raw.get("is_accessible", raw.get("isAccessible", True))),
            )
        )
    return tuple(sources)


def _clip_db_text(value: str | None, limit: int) -> str | None:
    """Keep persisted source fields within the Prisma varchar contract.

    Scrapers may return richer excerpts than the durable progress ledger
    stores. Truncating at this boundary keeps one oversized page from
    aborting the whole terminal transaction and leaving the job running.
    """
    if value is None:
        return None
    if len(value) <= limit:
        return value
    suffix = "…"
    return f"{value[: max(0, limit - len(suffix))].rstrip()}{suffix}"


def _json_int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _row_to_snapshot(row: dict[str, object]) -> JobSnapshot:
    src_refs_val = row.get("sourceRefs") or []
    src_refs_list = list(src_refs_val) if isinstance(src_refs_val, (list, tuple)) else []
    clean: list[dict[str, str | bool]] = []
    for item in src_refs_list:
        if isinstance(item, dict):
            clean.append({
                str(k): bool(v) if isinstance(v, bool) else str(v)
                for k, v in item.items()
                if isinstance(k, str) and isinstance(v, (str, bool))
            })
    context_val = row.get("context")
    context_str: str | None = context_val if isinstance(context_val, str) else None
    cur_step_val = row.get("currentStep")
    cur_step_str: AiJobStep | None = cast(AiJobStep, str(cur_step_val)) if isinstance(cur_step_val, str) else None
    max_urls_val = row.get("maxUrlsToScrape")
    max_urls = (
        int(max_urls_val)
        if isinstance(max_urls_val, int) and not isinstance(max_urls_val, bool)
        else None
    )
    return JobSnapshot(
        job_id=str(row["id"]),
        requester_id=str(row["requesterId"]),
        topic=str(row["topic"]),
        context=context_str,
        report_type=cast(
            Literal["research_report", "summary_brief", "slides", "web_brief", "evidence_search"],
            str(row.get("reportType", "research_report")),
        ),
        source_policy=cast(
            Literal["prefer_user_sources", "only_user_sources"],
            str(row.get("sourcePolicy", "prefer_user_sources")),
        ),
        status=cast(AiJobStatus, str(row["status"])),
        current_step=cur_step_str,
        attempts=cast(int, row.get("attempts")) if row.get("attempts") is not None else 0,
        idempotency_key=(
            str(row["idempotencyKey"]) if row.get("idempotencyKey") else None
        ),
        source_refs=tuple(clean),
        report_length=str(row.get("reportLength") or "standard"),
        max_urls_to_scrape=max_urls,
    )


def _view_from_row(row_dict: dict[str, Any]) -> DbJobView:
    """Build a DbJobView from a raw row dict.

    Shared by :meth:`DbJobStore.get_row` and :meth:`DbJobStore.list_jobs`.
    Note: callers are responsible for hydrating ``last_token_in/out/cost_cents``
    and ``last_error_code/message`` from the row dict — the two call sites
    differ slightly (get_row hydrates from current columns, list_jobs hydrates
    from a join-superset that also carries ``publishedResearchId``).
    """
    return DbJobView(
        snapshot=_row_to_snapshot(row_dict),
        last_sources=(),
        last_token_in=int(row_dict.get("tokenInputTotal") or 0),
        last_token_out=int(row_dict.get("tokenOutputTotal") or 0),
        last_cost_cents=int(row_dict.get("costCents") or 0),
        last_error_code=row_dict.get("errorCode"),
        last_error_message=row_dict.get("errorMessage"),
        last_error_details=(row_dict.get("errorDetails") if isinstance(row_dict.get("errorDetails"), dict) else None),
        review_details=(row_dict.get("reviewDetails") if isinstance(row_dict.get("reviewDetails"), dict) else None),
    )


class DbJobStore(JobStore):
    """PostgreSQL-backed JobStore using AsyncConnectionPool."""

    def __init__(
        self,
        *,
        dsn: str | None = None,
        table_name: str = AI_TABLE,
        lease_seconds: int | None = None,
        heartbeat_seconds: int | None = None,
        min_size: int | None = None,
        max_size: int | None = None,
    ) -> None:
        if table_name not in SHARED_TABLES:
            raise AdapterError(
                code="VALIDATION_FAILED",
                message=f"DbJobStore only knows tables {SHARED_TABLES}, got {table_name!r}",
            )
        self._table_name = table_name
        self._dsn = dsn or os.environ.get("DATABASE_URL") or ""
        if not self._dsn:
            raise AdapterError(
                code="VALIDATION_FAILED",
                message="DbJobStore requires DATABASE_URL (env or constructor)",
            )
        # The lease is a crash-recovery window, not the job budget. Heartbeats
        # renew it every 15s, so keeping it close to a few missed heartbeats
        # lets a restarted worker reclaim an orphaned job promptly instead of
        # leaving the UI stuck for the full research timeout.
        configured_lease_seconds = lease_seconds or int(
            os.environ.get("WORKER_LEASE_SECONDS", "180")
        )
        # A deep research job has an explicit end-to-end budget which is
        # longer than the historical five-minute/default lease. The lease is
        # only a crash-recovery window, but it must still cover the budget so
        # the reaper cannot take a healthy job away while it is writing or
        # reviewing. Keep 120s for the worker to persist its terminal state.
        if table_name == AI_TABLE:
            try:
                deep_budget = int(os.environ.get("DEEP_RESEARCH_TIMEOUT_SECONDS", "1200"))
            except (TypeError, ValueError):
                deep_budget = 1200
            deep_budget = max(1, deep_budget)
            self._lease_seconds = max(configured_lease_seconds, deep_budget + 120)
        else:
            self._lease_seconds = configured_lease_seconds
        self._heartbeat_seconds = heartbeat_seconds or int(
            os.environ.get("WORKER_HEARTBEAT_SECONDS", "15")
        )
        # Fact review has its own bounded lease. It is longer than one
        # reviewer request (including its retry), but short enough that a
        # restarted engine does not leave a draft waiting for ten minutes.
        try:
            review_timeout = int(os.environ.get("FACT_REVIEW_TIMEOUT_SECONDS", "180"))
        except (TypeError, ValueError):
            review_timeout = 180
        self._review_lease_seconds = min(max(review_timeout + 60, 120), 900)
        self._review_heartbeat_seconds = min(
            max(int(os.environ.get("FACT_REVIEW_HEARTBEAT_SECONDS", "15")), 5),
            max(5, self._review_lease_seconds // 3),
        )
        # A process restart must not leave a research page claiming to be
        # running until the full (sometimes 17-minute) lease expires. Healthy
        # workers renew well inside this window; a stale heartbeat is therefore
        # a safe early signal that the old process is gone. Keep this separate
        # from the lease because the same WORKER_LEASE_SECONDS setting is also
        # used by slower non-AI workers.
        self._stale_heartbeat_seconds = max(
            self._heartbeat_seconds * 4,
            int(os.environ.get("AI_JOB_STALE_HEARTBEAT_SECONDS", "60")),
        )
        self._max_retries = int(os.environ.get("WORKER_MAX_RETRIES", "3"))
        self._pool_min_size = min_size if min_size is not None else int(
            os.environ.get("DB_POOL_MIN_SIZE", "2")
        )
        self._pool_max_size = max_size if max_size is not None else int(
            os.environ.get("DB_POOL_MAX_SIZE", "10")
        )
        if self._pool_min_size < 1 or self._pool_max_size < self._pool_min_size:
            raise AdapterError(
                code="VALIDATION_FAILED",
                message="DB pool sizes must satisfy 1 <= min_size <= max_size",
            )
        self._pool: AsyncConnectionPool | None = None
        self._pool_open: bool = False
        self._reaper_task: asyncio.Task[None] | None = None
        self._reaper_stop = asyncio.Event()

    @property
    def table_name(self) -> str:
        return self._table_name

    @property
    def pool(self) -> AsyncConnectionPool:
        if self._pool is None or not self._pool_open:
            raise RuntimeError("DbJobStore pool is not open")
        return self._pool

    async def open(self) -> None:
        if not self._pool_open:
            self._pool = AsyncConnectionPool(
                conninfo=self._dsn,
                min_size=self._pool_min_size,
                max_size=self._pool_max_size,
                kwargs={"row_factory": dict_row},
                open=False,
            )
            await self._pool.open()
            await self._pool.wait()
            self._pool_open = True

    async def close(self) -> None:
        if self._reaper_stop.is_set() is False:
            self._reaper_stop.set()
        if self._reaper_task is not None and not self._reaper_task.done():
            self._reaper_task.cancel()
            try:
                await self._reaper_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._pool is not None and not self._pool.closed:
            await self._pool.close()
        self._pool_open = False

    async def __aenter__(self) -> "DbJobStore":
        await self.open()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def resolve_internal_source_refs(
        self,
        source_refs: Sequence[dict[str, str | bool]],
        *,
        requester_id: str,
    ) -> tuple[dict[str, str | bool], ...]:
        """Hydrate visible summary/research ids for the adapter.

        Clients only send stable ids. The DB boundary owns visibility checks
        and adds bounded title/snippet metadata; adapters must never invent
        content when an internal source was explicitly requested.
        """
        await self.open()
        hydrated: list[dict[str, str | bool]] = []
        async with self.pool.connection() as conn:
            for ref in source_refs:
                kind = ref.get("type")
                value = ref.get("value")
                if kind not in {"summary", "research"} or not isinstance(value, str):
                    hydrated.append(dict(ref))
                    continue
                try:
                    uuid.UUID(value)
                except ValueError as exc:
                    raise AdapterError(
                        code="VALIDATION_FAILED",
                        message=f"source ref {kind} must be a UUID",
                    ) from exc

                if kind == "summary":
                    row = await conn.execute(
                        'SELECT title, url, interpretation, body FROM summaries WHERE id = %s',
                        (value,),
                    )
                else:
                    row = await conn.execute(
                        'SELECT title, NULL::text AS url, NULL::text AS interpretation, body '
                        'FROM researches WHERE id = %s AND (status = \'published\' OR "authorId" = %s)',
                        (value, requester_id),
                    )
                found = await row.fetchone()
                if found is None:
                    if ref.get("required") is True:
                        raise AdapterError(
                            code="AI_SOURCE_NOT_VISIBLE",
                            message=f"required {kind} source is missing or not visible",
                        )
                    hydrated.append(dict(ref))
                    continue
                found_dict = cast(dict[str, Any], found)
                resolved = dict(ref)
                resolved["resolvedTitle"] = str(found_dict.get("title") or "")[:300]
                # Keep the hydrated payload within the ai_research_sources
                # VARCHAR(2000) contract.  This value is copied into
                # AdapterSource.snippet and persisted during record_progress;
                # allowing 4000 chars here makes a real internal research
                # source fail at terminal persistence instead of producing a
                # grounded result.
                resolved["resolvedSnippet"] = str(
                    found_dict.get("interpretation") or found_dict.get("body") or ""
                )[:2000]
                if found_dict.get("url"):
                    resolved["resolvedUrl"] = str(found_dict["url"])[:2000]
                hydrated.append(resolved)
        return tuple(hydrated)

    async def load_radar_context_refs(
        self,
        *,
        limit: int | None = None,
        days: int | None = None,
    ) -> tuple[dict[str, str | bool], ...]:
        """Load recent radar context for an explicit opt-in workflow.

        Normal AI research submissions do not call this method. Project
        history is a user-controlled source, not an implicit expansion of the
        confirmed research boundary.
        """
        await self.open()
        limit = limit if limit is not None else int(
            os.environ.get("AI_RESEARCH_AUTO_RADAR_LIMIT", str(AUTO_RADAR_LIMIT))
        )
        days = days if days is not None else int(
            os.environ.get("AI_RESEARCH_AUTO_RADAR_DAYS", str(AUTO_RADAR_DAYS))
        )
        since = _now_utc() - timedelta(days=days)
        hydrated: list[dict[str, str | bool]] = []
        async with self.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    """
                    SELECT "id", "title", "url", "interpretation", "body"
                    FROM "summaries"
                    WHERE "status" IN ('candidate', 'published')
                      AND "distilledTier" = ANY(%s)
                      AND ("publishedAt" >= %s OR "createdAt" >= %s)
                    ORDER BY COALESCE("publishedAt", "createdAt") DESC
                    LIMIT %s
                    """,
                    (list(AUTO_RADAR_TIERS), since, since, limit),
                )
            ).fetchall()
        for row in rows:
            found = cast(dict[str, Any], row)
            snippet = str(
                found.get("interpretation") or found.get("body") or ""
            ).strip()[:2000]
            if not snippet:
                continue
            resolved: dict[str, str | bool] = {
                "type": "summary",
                "value": str(found["id"]),
                "required": False,
                "auto": True,
                "resolvedTitle": str(found.get("title") or "")[:300],
                "resolvedSnippet": snippet,
            }
            if found.get("url"):
                resolved["resolvedUrl"] = str(found["url"])[:2000]
            hydrated.append(resolved)
        return tuple(hydrated)

    # ─────────────── JobStore Protocol ────────────────

    async def enqueue(self, snapshot: JobSnapshot) -> None:
        await self.open()
        t = f'"{self._table_name}"'
        params: tuple[object, ...]
        if self._table_name == IMPORT_TABLE:
            # content_import_jobs has different columns from ai_research_jobs
            # W2 review #4 fix: enqueue supports import table specific fields
            # content_import_jobs has no updatedAt column — must avoid
            # triggering touch_updated_at trigger which references it.
            # The createdAt column is auto-populated by the default.
            sql = (
                f"INSERT INTO {t} "
                f'("id", "requesterId", "sourceKind", "status", "attempts", '
                f'"converterVersion", "createdAt") '
                f"VALUES (%s, %s, %s, %s, %s, %s, now()) "
                f"ON CONFLICT (id) DO NOTHING"
            )
            params = (
                snapshot.job_id,
                snapshot.requester_id,
                "file",  # P0 default
                "queued",
                0,
                "w3-v1",
            )
        else:
            sql = (
                f"INSERT INTO {t} "
                f'("id", "requesterId", "topic", "context", "reportType", "artifactType", "sourcePolicy", '
                f'"reportLength", "maxUrlsToScrape", "status", "currentStep", "attempts", "idempotencyKey", "sourceRefs", '
                f'"partialSources", "failedSources", "updatedAt") '
                f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, now()) "
                # The Web BFF creates the row before forwarding the request.
                # Update only the resolved refs on that conflict, in the same
                # transaction as enqueue, so the DB worker cannot acquire the
                # row in the small gap before a separate hydration UPDATE.
                f'ON CONFLICT (id) DO UPDATE SET '
                # The Web BFF normally creates the row first. Keep the
                # engine's idempotent enqueue path authoritative too, so a
                # retry or another caller cannot leave reportType and
                # artifactType out of sync.
                f'"reportType" = EXCLUDED."reportType", '
                f'"artifactType" = EXCLUDED."artifactType", '
                f'"reportLength" = EXCLUDED."reportLength", '
                f'"maxUrlsToScrape" = EXCLUDED."maxUrlsToScrape", '
                f'"sourceRefs" = EXCLUDED."sourceRefs"'
            )
            ai_params: tuple[object, ...] = (
                snapshot.job_id,
                snapshot.requester_id,
                snapshot.topic,
                snapshot.context,
                snapshot.report_type,
                "slides" if snapshot.report_type == "slides" else "markdown",
                snapshot.source_policy,
                snapshot.report_length,
                snapshot.max_urls_to_scrape,
                "queued",
                snapshot.current_step,
                snapshot.attempts,
                snapshot.idempotency_key,
                json.dumps(list(snapshot.source_refs)),
                json.dumps([]),
                json.dumps([]),
            )
            params = ai_params
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(sql, params)

    async def persist_source_refs(
        self,
        job_id: str,
        source_refs: Sequence[dict[str, str | bool]],
    ) -> None:
        """Update hydrated source refs on an already-created AI research row.

        The BFF creates the row before forwarding to the engine, so
        ``enqueue`` updates refs atomically on the BFF's pre-created row;
        this method remains for callers that need to repair an already
        persisted job without re-enqueueing it.
        """
        await self.open()
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE "ai_research_jobs"
                    SET "sourceRefs" = %s::jsonb, "updatedAt" = now()
                    WHERE "id" = %s
                    """,
                    (json.dumps(list(source_refs)), job_id),
                )

    async def find_by_idempotency_key(
        self, requester_id: str, idempotency_key: str
    ) -> "DbJobView | None":
        """W6: Look up an existing job by (requester_id, idempotency_key).

        Backed by a partial unique index on ai_research_jobs (see migration
        init_constraints). Returns a DbJobView so the caller can read .snapshot.
        """
        await self.open()
        # Partial unique applies only when idempotencyKey IS NOT NULL.
        if self._table_name != AI_TABLE:
            return None
        t = f'"{self._table_name}"'
        sql = (
            f"SELECT j.\"id\", j.\"requesterId\", j.\"topic\", j.\"context\", "
            f"j.\"reportType\", j.\"sourcePolicy\", j.\"reportLength\", j.\"maxUrlsToScrape\", "
            f"j.\"status\", j.\"currentStep\", j.\"attempts\", j.\"idempotencyKey\", j.\"sourceRefs\" "
            f"FROM {t} j "
            f"WHERE j.\"requesterId\" = %s AND j.\"idempotencyKey\" = %s "
            f"LIMIT 1"
        )
        async with self.pool.connection() as conn:
            row = await (await conn.execute(sql, (requester_id, idempotency_key))).fetchone()
        if row is None:
            return None
        snapshot = _row_to_snapshot(dict(row))
        return DbJobView(
            snapshot=snapshot,
            last_sources=(),
        )

    async def count_submissions_today(
        self,
        *,
        requester_id: str | None = None,
        team_scope: bool = False,
    ) -> int:
        """W6: count submissions since today UTC midnight.

        - requester_id non-None → per-user count (team_scope must be False)
        - team_scope=True → team-wide count (requester_id must be None)

        Counts all statuses EXCEPT cancelled (those don't count toward quota).
        """
        await self.open()
        if team_scope and requester_id is not None:
            raise ValueError(
                "count_submissions_today: pick one of team_scope or requester_id"
            )
        if self._table_name != AI_TABLE:
            return 0
        t = f'"{self._table_name}"'
        params: list[object] = []
        where = ['"createdAt" >= date_trunc(\'day\', now())', '"status" <> \'cancelled\'']
        if requester_id is not None:
            where.append('"requesterId" = %s')
            params.append(requester_id)
        sql = f"SELECT count(*) AS cnt FROM {t} WHERE {' AND '.join(where)}"
        async with self.pool.connection() as conn:
            row = await (await conn.execute(sql, tuple(params))).fetchone()
        row_data = cast(dict[str, Any] | None, row)
        return int(row_data["cnt"]) if row_data else 0

    async def acquire_next_job(
        self, worker_id: str
    ) -> tuple[JobLease, JobSnapshot] | None:
        await self.open()
        now = _now_utc()
        lease_expires_at = now + timedelta(seconds=self._lease_seconds)
        t = f'"{self._table_name}"'

        if self._table_name == IMPORT_TABLE:
            # content_import_jobs has different columns from ai_research_jobs
            returning_cols = (
                "j.\"id\", j.\"requesterId\", j.\"sourceKind\", j.\"status\", j.\"attempts\", "
                "j.\"originalFilename\", j.\"mimeType\", j.\"sizeBytes\", j.\"contentSha256\""
            )
        else:
            returning_cols = (
                'j."id", j."requesterId", j."topic", j."context", j."reportType", '
                'j."sourcePolicy", j."reportLength", j."maxUrlsToScrape", '
                'j."status", j."currentStep", j."attempts", '
                'j."idempotencyKey", j."sourceRefs"'
            )

        # Build the SET clause as a list so the join commas are unambiguous
        # across the two job tables.  content_import_jobs has no startedAt
        # column; ai_research_jobs uses it to record the first acquire time
        # (coalesced so a re-acquire after retry keeps the original stamp).
        set_clauses = [
            "\"status\" = 'running'",
            '"lockedBy" = %s',
            '"leaseExpiresAt" = %s',
            '"heartbeatAt" = %s',
        ]
        if self._table_name != IMPORT_TABLE:
            set_clauses.append('"startedAt" = COALESCE("startedAt", now())')
        set_clause = ",\n            ".join(set_clauses)

        sql = (
            f"WITH cte AS ("
            f'  SELECT "id" FROM {t} '
            f"  WHERE \"status\" = 'queued' "
            f'    AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= now()) '
            f'  ORDER BY "createdAt" ASC '
            f"  FOR UPDATE SKIP LOCKED "
            f"  LIMIT 1"
            f") "
            f"UPDATE {t} AS j "
            f"SET {set_clause} "
            f"FROM cte "
            f'WHERE j."id" = cte."id" '
            f"RETURNING {returning_cols}"
        )
        params = (worker_id, lease_expires_at, now)
        async with self.pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute(sql, params)
                row = await cur.fetchone()
        if row is None:
            return None
        # Pool is configured with dict_row; psycopg's generic defaults do not
        # preserve that row shape in its public type parameter.
        row_dict = cast(dict[str, Any], row)

        # For import table, construct snapshot from import-specific columns
        if self._table_name == IMPORT_TABLE:
            snapshot = JobSnapshot(
                job_id=str(row_dict["id"]),
                requester_id=str(row_dict["requesterId"]),
                topic=str(row_dict.get("originalFilename", "import") or "import"),
                context=None,
                report_type="summary_brief",
                source_policy="prefer_user_sources",
                status=cast(AiJobStatus, str(row_dict["status"])),
                current_step=None,
                attempts=cast(int, row_dict.get("attempts")) or 0,
                idempotency_key=None,
                source_refs=(),
            )
        else:
            snapshot = _row_to_snapshot(row_dict)
        lease = JobLease(
            job_id=snapshot.job_id,
            worker_id=worker_id,
            locked_by=worker_id,
            lease_expires_at=lease_expires_at,
            heartbeat_interval_seconds=self._heartbeat_seconds,
        )
        return lease, snapshot

    async def heartbeat(self, lease: JobLease) -> HeartbeatResult:
        await self.open()
        now = _now_utc()
        new_expiry = now + timedelta(seconds=self._lease_seconds)
        t = f'"{self._table_name}"'
        sql = (
            f"UPDATE {t} "
            f'SET "leaseExpiresAt" = %s, "heartbeatAt" = %s '
            f'WHERE "id" = %s AND "lockedBy" = %s AND "status" = \'running\' '
            f'RETURNING "leaseExpiresAt"'
        )
        async with self.pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute(sql, (new_expiry, now, lease.job_id, lease.worker_id))
                row = await cur.fetchone()
        if row is None:
            return HeartbeatResult(renewed=False, lease_expires_at=None, reason="lease_lost")
        return HeartbeatResult(renewed=True, lease_expires_at=new_expiry)

    async def record_progress(
        self,
        lease: JobLease,
        *,
        current_step: AiJobStep | None,
        token_in: int,
        token_out: int,
        cost_cents: int,
        sources: Iterable[AdapterSource],
        review_details: dict[str, object] | None = None,
        output_text: str | None = None,
        prune_sources: bool = False,
    ) -> None:
        # content_import_jobs doesn't have currentStep / tokenInputTotal / partialSources
        # columns — record_progress is a no-op for the import table. The import worker
        # writes outputResearchId and status via mark_terminal.
        if self._table_name == IMPORT_TABLE:
            return
        await self.open()
        # A discovered URL without a fetched excerpt is live progress, not an
        # inspectable source. Keep it out of the durable evidence ledger.
        source_items = [
            source for source in sources
            if source.evidence_status == "fetched" and (source.snippet or "").strip()
        ]
        sources_json = json.dumps(
            [
                {
                    "source_ref": s.source_ref,
                    "canonical_key": s.canonical_key[:512],
                    "title": _clip_db_text(s.title, 300),
                    "snippet": _clip_db_text(s.snippet, 2000),
                    "score": s.score,
                    "step_captured": s.step_captured,
                    "is_accessible": s.is_accessible,
                }
                for s in source_items
            ],
            ensure_ascii=False,
        )
        t = f'"{self._table_name}"'
        checkpoint_clause = '    "outputText" = COALESCE(%s, "outputText") '
        sql = (
            f"UPDATE {t} "
            f'SET "currentStep" = %s, "tokenInputTotal" = %s, "tokenOutputTotal" = %s, '
            f'    "costCents" = %s, "partialSources" = %s::jsonb, "reviewDetails" = %s::jsonb, '
            f'{checkpoint_clause}'
            f'WHERE "id" = %s AND "lockedBy" = %s AND "status" = \'running\''
        )
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(
                    sql,
                    (
                        current_step,
                        token_in,
                        token_out,
                        cost_cents,
                        sources_json,
                        json.dumps(review_details, ensure_ascii=False) if review_details is not None else None,
                        output_text.strip() if output_text and output_text.strip() else None,
                        lease.job_id,
                        lease.worker_id,
                    ),
                )
                if source_items:
                    await conn.execute(
                        'INSERT INTO "ai_research_sources" '
                        '("jobId", "sourceRef", "canonicalKey", "title", "snippet", "score", "stepCaptured") '
                        'SELECT %s, s.source_ref, s.canonical_key, s.title, s.snippet, s.score, '
                        '       s.step_captured::"AiJobStep" '
                        'FROM jsonb_to_recordset(%s::jsonb) AS s('
                        '  source_ref jsonb, canonical_key text, title text, snippet text, '
                        '  score double precision, step_captured text'
                        ') '
                        'ON CONFLICT ("jobId", "canonicalKey") DO UPDATE SET '
                        '  "sourceRef" = EXCLUDED."sourceRef", '
                        '  "title" = EXCLUDED."title", '
                        '  "snippet" = EXCLUDED."snippet", '
                        '  "score" = EXCLUDED."score", '
                        '  "stepCaptured" = EXCLUDED."stepCaptured"',
                        (lease.job_id, sources_json),
                    )
                if prune_sources:
                    if source_items:
                        await conn.execute(
                            'DELETE FROM "ai_research_sources" '
                            'WHERE "jobId" = %s AND "canonicalKey" NOT IN ('
                            '  SELECT s.canonical_key '
                            '  FROM jsonb_to_recordset(%s::jsonb) AS s(canonical_key text)'
                            ')',
                            (lease.job_id, sources_json),
                        )
                    else:
                        await conn.execute(
                            'DELETE FROM "ai_research_sources" WHERE "jobId" = %s',
                            (lease.job_id,),
                        )

    async def mark_terminal(
        self,
        lease: JobLease,
        status: Literal["succeeded", "partial", "failed", "cancelled"],
        *,
        current_step: AiJobStep | None,
        error_code: str | None,
        error_message: str | None,
        draft_research_id: str | None,
        output_text: str | None = None,
        error_details: dict[str, object] | None = None,
        review_details: dict[str, object] | None = None,
    ) -> None:
        await self.open()
        t = f'"{self._table_name}"'
        params: tuple[object, ...]

        if self._table_name == IMPORT_TABLE:
            # content_import_jobs uses outputResearchId (not draftResearchId),
            # has no currentStep column, and accepts succeeded/failed/partial/cancelled
            # directly (no ai_jobs_draft_matches_status CHECK for import table).
            sql = (
                f"UPDATE {t} "
                f'SET "status" = %s, "errorCode" = %s, "errorMessage" = %s, '
                f'    "outputResearchId" = %s, "completedAt" = now(), '
                f'    "lockedBy" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL '
                f'WHERE "id" = %s AND "lockedBy" = %s AND "status" = \'running\' '
                f'RETURNING "id"'
            )
            params = (
                status,
                error_code,
                error_message,
                draft_research_id,
                lease.job_id,
                lease.worker_id,
            )
        else:
            # A succeeded research_report/web_brief owns a draft; a
            # succeeded summary_brief and a partial research run may own
            # inline output.
            # Inline partial output is read-only and never a Research draft.
            if status == "succeeded" and bool(draft_research_id) == bool(output_text):
                raise ValueError(
                    "mark_terminal: succeeded requires exactly one of "
                    "draft_research_id or output_text"
                )
            if status == "partial" and draft_research_id is not None:
                raise ValueError("mark_terminal: partial cannot persist a research draft")
            if status == "partial" and output_text is not None and not output_text.strip():
                raise ValueError("mark_terminal: partial output_text must not be blank")
            if status not in {"succeeded", "partial"} and (
                draft_research_id is not None or output_text is not None
            ):
                raise ValueError(
                    f"mark_terminal: status={status} cannot persist output"
                )
            # W2 review 修正:不再自造 sentinel 假 sources。schema CHECK
            # ai_jobs_partial_sources_valid 要求 succeeded >= 1 sources,
            # partial >= 3 sources。caller(adapter)在 mark_terminal 之前
            # 自己 record_progress 写真 sources;db_store 不再写 partialSources。
            review_status = review_details.get("status") if review_details else None
            review_attempts = _json_int(review_details.get("attempts", 0)) if review_details else 0
            review_summary = (
                {
                    "corrected_count": review_details.get("corrected_count", 0),
                    "unverified_count": review_details.get("unverified_count", 0),
                    "not_judged_count": review_details.get("not_judged_count", 0),
                    "execution_failed_claim_count": review_details.get("execution_failed_claim_count", 0),
                    "disputed_count": review_details.get("disputed_count", 0),
                    "contradicted_count": review_details.get("contradicted_count", 0),
                    "factual_claim_count": review_details.get("factual_claim_count", 0),
                    "citation_count": review_details.get("citation_count", 0),
                    "citation_pending_count": review_details.get("citation_pending_count", 0),
                    "evidence_binding_repaired_count": review_details.get("evidence_binding_repaired_count", 0),
                    "coverage_status": review_details.get("coverage_status", "complete"),
                    "review_outcome": review_details.get("review_outcome"),
                }
                if review_details
                else None
            )
            review_claims = review_details.get("claims", []) if review_details else []
            sql = (
                f"UPDATE {t} "
                f'SET "status" = %s, "currentStep" = %s, "errorCode" = %s, "errorMessage" = %s, "errorDetails" = %s::jsonb, '
                f'    "reviewStatus" = %s, "reviewAttempts" = %s, "reviewStartedAt" = NULL, "reviewRunToken" = NULL, '
                f'    "reviewSummary" = %s::jsonb, "reviewClaims" = %s::jsonb, '
                f'    "reviewedAt" = CASE WHEN %s IN (\'passed\', \'needs_revision\', \'blocked\', \'review_unavailable\') THEN now() ELSE NULL END, '
                f'    "reviewDetails" = %s::jsonb, '
                f'    "draftResearchId" = %s, "outputText" = %s, "completedAt" = now(), '
                f'    "lockedBy" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL '
                f'WHERE "id" = %s AND "lockedBy" = %s AND "status" = \'running\' '
                f'RETURNING "id"'
            )
            params = (
                status,
                current_step,
                error_code,
                error_message,
                json.dumps(error_details, ensure_ascii=False) if error_details is not None else None,
                review_status,
                review_attempts,
                json.dumps(review_summary, ensure_ascii=False) if review_summary is not None else None,
                json.dumps(review_claims, ensure_ascii=False),
                review_status,
                json.dumps(review_details, ensure_ascii=False) if review_details is not None else None,
                draft_research_id,
                output_text,
                lease.job_id,
                lease.worker_id,
            )
        async with self.pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute(sql, params)
                row = await cur.fetchone()
        if row is None:
            raise LeaseLostError(
                f"mark_terminal: lease for {lease.job_id} no longer held by {lease.worker_id}"
            )

    async def claim_next_review(self, worker_id: str) -> ReviewWorkItem | None:
        """Claim one version-scoped review run without touching job leases.

        ``research_review_runs`` is the queue.  The old job/research review
        columns remain mirrors for API compatibility, but they are not used
        to decide which document is current.  This is what makes a forked
        draft reviewable even when it no longer has an AI job row.
        """
        if self._table_name != AI_TABLE:
            return None
        await self.open()
        claim_token = str(uuid.uuid4())
        # Lock the run first because it is the queue unit.  A stale run is
        # reclaimable after ten minutes, so a crashed reviewer cannot strand
        # a document forever.  A single research may have many historical
        # runs, but only queued/running runs are eligible here.
        select_sql = (
            'SELECT rr."id" AS "reviewRunId", rr."researchId", rr."aiResearchJobId", '
            '  rr."revisionHash", rr."sourceSnapshotHash", rr."attempt", '
            '  rr."details" AS "runDetails", rr."executionStatus", rr."leaseExpiresAt", '
            '  r."authorId", r."title", r."body", '
            '  (SELECT COALESCE(jsonb_agg(jsonb_build_object('
            '    \'source_ref\', rs."sourceRef", \'canonical_key\', rs."canonicalKey", '
            '    \'title\', rs."title", \'snippet\', rs."description", \'step_captured\', \'search\')), \'[]\'::jsonb) '
            '   FROM "research_sources" rs WHERE rs."researchId" = r."id") AS "sourceSnapshot", '
            '  j."id" AS "jobId", j."topic", j."reportType", j."reviewAttempts", '
            '  j."reviewDetails" AS "jobReviewDetails" '
            'FROM "research_review_runs" rr '
            'JOIN "researches" r ON r."id" = rr."researchId" '
            'LEFT JOIN "ai_research_jobs" j ON j."id" = rr."aiResearchJobId" '
            'WHERE r."status" = \'draft\' '
            '  AND rr."executionStatus" IN (\'queued\', \'reviewing\') '
            '  AND (rr."executionStatus" = \'queued\' '
            '       OR (rr."leaseExpiresAt" IS NOT NULL AND rr."leaseExpiresAt" < now()) '
            '       OR (rr."leaseExpiresAt" IS NULL AND (rr."startedAt" IS NULL '
            '           OR rr."startedAt" < now() - interval \'10 minutes\'))) '
            'ORDER BY rr."createdAt" ASC '
            'FOR UPDATE OF rr SKIP LOCKED LIMIT 1'
        )
        async with self.pool.connection() as conn:
            async with conn.transaction():
                row = await (await conn.execute(select_sql)).fetchone()
                if row is None:
                    return None
                raw = cast(dict[str, object], row)
                run_id = str(raw["reviewRunId"])
                job_id = str(raw["jobId"]) if raw.get("jobId") else None
                attempt = _json_int(raw.get("attempt"), 0) + 1
                await conn.execute(
                    'UPDATE "research_review_runs" SET '
                    '  "executionStatus" = \'reviewing\', "attempt" = %s, '
                    '  "startedAt" = now(), '
                    '  "leaseExpiresAt" = now() + (%s::int * interval \'1 second\'), '
                    '  "heartbeatAt" = now(), "completedAt" = NULL, '
                    '  "details" = COALESCE("details", \'{}\'::jsonb) || '
                    '    jsonb_build_object(\'phase\', \'reviewing\', \'workerId\', %s::text, \'claimToken\', %s::text) '
                    'WHERE "id" = %s',
                    (attempt, self._review_lease_seconds, worker_id, claim_token, run_id),
                )
                if job_id:
                    await conn.execute(
                        'UPDATE "ai_research_jobs" SET '
                        '  "reviewStatus" = \'reviewing\', "reviewAttempts" = %s, '
                        '  "reviewStartedAt" = now(), "reviewRunToken" = %s, '
                        '  "reviewDetails" = COALESCE("reviewDetails", \'{}\'::jsonb) || '
                        '    jsonb_build_object(\'phase\', \'reviewing\', \'status\', \'reviewing\', '
                        '      \'attempts\', %s::int, \'startedAt\', now(), \'workerId\', %s::text, \'claimToken\', %s::text), '
                        '  "reviewedAt" = NULL WHERE "id" = %s',
                        (attempt, claim_token, attempt, worker_id, claim_token, job_id),
                    )
                # The run is the queue's source of truth, but the linked
                # research row is also read directly by the editor and the
                # publish gate. Keep that compatibility mirror in the same
                # transaction so no surface can remain stuck at "queued"
                # after the worker has actually started.
                await conn.execute(
                    'UPDATE "researches" SET '
                    '  "reviewStatus" = \'reviewing\', "reviewAttempts" = %s, '
                    '  "reviewStartedAt" = now(), "reviewRunToken" = %s, '
                    '  "reviewDetails" = COALESCE("reviewDetails", \'{}\'::jsonb) || '
                    '    jsonb_build_object(\'phase\', \'reviewing\', \'status\', \'reviewing\', '
                    '      \'attempts\', %s::int, \'startedAt\', now(), \'workerId\', %s::text, \'claimToken\', %s::text), '
                    '  "reviewedAt" = NULL WHERE "id" = %s',
                    (attempt, claim_token, attempt, worker_id, claim_token, str(raw["researchId"])),
                )
        if row is None:
            return None
        raw = cast(dict[str, object], row)
        report = raw.get("body")
        details = raw.get("runDetails")
        if not isinstance(details, dict):
            details = {}
        job_details = raw.get("jobReviewDetails")
        if isinstance(job_details, dict):
            details = {**job_details, **details}
        review_mode_value = details.get("reviewMode")
        review_mode = (
            review_mode_value
            if review_mode_value in {"full", "evidence_challenge", "claim_verification"}
            else "full"
        )
        target_claim_value = details.get("targetClaim")
        target_claim = target_claim_value if isinstance(target_claim_value, dict) else None
        if not isinstance(report, str) or not report.strip():
            # A malformed legacy row should not spin forever. Leave it as an
            # unavailable review; the report itself remains readable.
            details.update({"phase": "completed", "status": "review_unavailable", "error_code": "no_report"})
            await self.complete_review(
                ReviewWorkItem(
                    job_id=str(raw["jobId"] or raw["reviewRunId"]), requester_id=str(raw["authorId"]),
                    topic=str(raw.get("topic") or raw["title"]), report_type=str(raw.get("reportType") or "research_report"),
                    report="", sources=_review_sources(raw.get("sourceSnapshot")),
                    draft_research_id=str(raw["researchId"]), attempts=attempt,
                    review_details=details,
                    review_run_id=run_id,
                    revision_hash=str(raw["revisionHash"]),
                    source_snapshot_hash=str(raw["sourceSnapshotHash"]),
                    claim_token=claim_token,
                    review_mode=cast(Any, review_mode),
                    target_claim=target_claim,
                ),
                details,
            )
            return None
        return ReviewWorkItem(
            job_id=str(raw["jobId"] or ""),
            requester_id=str(raw["authorId"]),
            topic=str(raw.get("topic") or raw["title"]),
            report_type=str(raw.get("reportType") or "research_report"),
            report=report,
            sources=_review_sources(raw.get("sourceSnapshot")),
            draft_research_id=str(raw["researchId"]),
            attempts=attempt,
            review_details=details,
            review_run_id=run_id,
            revision_hash=str(raw["revisionHash"]),
            source_snapshot_hash=str(raw["sourceSnapshotHash"]),
            claim_token=claim_token,
            review_mode=cast(Any, review_mode),
            target_claim=target_claim,
        )

    async def heartbeat_review(self, work: ReviewWorkItem) -> bool:
        """Renew only the run still owned by this reviewer claim."""
        if self._table_name != AI_TABLE or not work.review_run_id or not work.claim_token:
            return False
        await self.open()
        async with self.pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute(
                    'UPDATE "research_review_runs" SET '
                    '  "leaseExpiresAt" = now() + (%s::int * interval \'1 second\'), '
                    '  "heartbeatAt" = now() '
                    'WHERE "id" = %s AND "executionStatus" = \'reviewing\' '
                    '  AND "leaseExpiresAt" > now() '
                    '  AND ("details"->>\'claimToken\') = %s',
                    (self._review_lease_seconds, work.review_run_id, work.claim_token),
                )
        return cur.rowcount == 1

    async def checkpoint_review(
        self,
        work: ReviewWorkItem,
        checkpoint: dict[str, object],
    ) -> bool:
        """Persist an observable review phase without changing its verdict.

        The phase is deliberately stored in ``details`` rather than the
        execution status column.  ``executionStatus=reviewing`` remains the
        queue-level state, while ``details.phase`` tells the UI whether the
        worker is inventorying statements, adjudicating evidence, matching
        the resulting links, or checking conflicts. The claim token is the
        fence against a late old worker.
        """
        if self._table_name != AI_TABLE or not work.review_run_id or not work.claim_token:
            return False
        phase = checkpoint.get("phase")
        if not isinstance(phase, str) or phase not in {
            "inventorying", "adjudicating", "matching", "conflict_check",
        }:
            return False
        await self.open()
        payload = dict(checkpoint)
        payload.pop("workerId", None)
        payload.pop("claimToken", None)
        async with self.pool.connection() as conn:
            async with conn.transaction():
                run_updated = await conn.execute(
                    'UPDATE "research_review_runs" SET '
                    '  "details" = COALESCE("details", \'{}\'::jsonb) || %s::jsonb, '
                    '  "heartbeatAt" = now(), '
                    '  "leaseExpiresAt" = now() + (%s::int * interval \'1 second\') '
                    'WHERE "id" = %s AND "executionStatus" = \'reviewing\' '
                    '  AND "leaseExpiresAt" > now() '
                    '  AND ("details"->>\'claimToken\') = %s',
                    (
                        json.dumps(payload, ensure_ascii=False),
                        self._review_lease_seconds,
                        work.review_run_id,
                        work.claim_token,
                    ),
                )
                if run_updated.rowcount != 1:
                    return False
                # Keep compatibility mirrors useful to clients that have not
                # loaded the run relation yet. The run remains authoritative.
                if work.job_id:
                    await conn.execute(
                        'UPDATE "ai_research_jobs" SET '
                        '  "reviewDetails" = COALESCE("reviewDetails", \'{}\'::jsonb) || %s::jsonb '
                        'WHERE "id" = %s AND "reviewStatus" = \'reviewing\' '
                        '  AND "reviewRunToken" = %s',
                        (
                            json.dumps(payload, ensure_ascii=False),
                            work.job_id,
                            work.claim_token,
                        ),
                    )
                await conn.execute(
                    'UPDATE "researches" SET '
                    '  "reviewDetails" = COALESCE("reviewDetails", \'{}\'::jsonb) || %s::jsonb '
                    'WHERE "id" = %s AND "reviewStatus" = \'reviewing\' '
                    '  AND "reviewRunToken" = %s',
                    (
                        json.dumps(payload, ensure_ascii=False),
                        work.draft_research_id,
                        work.claim_token,
                    ),
                )
        return True

    async def complete_review(
        self,
        work: ReviewWorkItem,
        review_details: dict[str, object],
    ) -> None:
        """Commit the review snapshot to both job and linked draft."""
        if self._table_name != AI_TABLE:
            return
        await self.open()
        status = review_details.get("status")
        status_value = status if isinstance(status, str) else "review_unavailable"
        summary = {
            "corrected_count": _json_int(review_details.get("corrected_count")),
            "unverified_count": _json_int(review_details.get("unverified_count")),
            "not_judged_count": _json_int(review_details.get("not_judged_count")),
            "execution_failed_claim_count": _json_int(review_details.get("execution_failed_claim_count")),
            "disputed_count": _json_int(review_details.get("disputed_count")),
            "contradicted_count": _json_int(review_details.get("contradicted_count")),
            "factual_claim_count": _json_int(review_details.get("factual_claim_count")),
            "citation_count": _json_int(review_details.get("citation_count")),
            "citation_pending_count": _json_int(review_details.get("citation_pending_count")),
            "evidence_binding_repaired_count": _json_int(review_details.get("evidence_binding_repaired_count")),
            "batch_count": _json_int(review_details.get("batch_count")),
            "completed_batch_count": _json_int(review_details.get("completed_batch_count")),
            "failed_batch_count": _json_int(review_details.get("failed_batch_count")),
            "judged_claim_count": _json_int(review_details.get("judged_claim_count")),
            "total_claim_count": _json_int(review_details.get("total_claim_count")),
            "coverage_status": (
                review_details.get("coverage_status")
                if isinstance(review_details.get("coverage_status"), str)
                else "complete"
            ),
            "review_outcome": (
                review_details.get("review_outcome")
                if isinstance(review_details.get("review_outcome"), str)
                else None
            ),
        }
        claims = review_details.get("claims")
        # ReviewResult.to_dict() intentionally preserves its immutable tuple
        # shape.  JSON can encode tuples, but this boundary used to reject
        # them and persist an empty ledger, making a real review look like it
        # had no claims at all.
        if isinstance(claims, tuple):
            claims = list(claims)
        elif not isinstance(claims, list):
            claims = []
        details = dict(review_details)
        details["phase"] = "completed"
        details["status"] = status_value
        details["attempts"] = work.attempts
        details.pop("workerId", None)
        details.pop("startedAt", None)
        details.pop("claimToken", None)
        sql = (
            'UPDATE "ai_research_jobs" SET '
            '"reviewStatus" = %s, "reviewSummary" = %s::jsonb, "reviewClaims" = %s::jsonb, '
            '"reviewDetails" = %s::jsonb, "reviewedAt" = now(), "reviewStartedAt" = NULL, "reviewRunToken" = NULL '
            'WHERE "id" = %s AND "reviewStatus" = \'reviewing\' '
            'AND "reviewRunToken" = %s'
        )
        draft_sql = (
            'UPDATE "researches" SET '
            '"reviewStatus" = %s, "reviewAttempts" = %s, "reviewSummary" = %s::jsonb, '
            '"reviewClaims" = %s::jsonb, "reviewDetails" = %s::jsonb, "reviewedAt" = now(), '
            '"reviewStartedAt" = NULL, "reviewRunToken" = NULL '
            'WHERE "id" = %s'
        )
        async with self.pool.connection() as conn:
            async with conn.transaction():
                # Lock/update the run before its compatibility mirrors.  PUT
                # invalidation takes the same run -> job -> research order;
                # keeping one order prevents a review completion racing with
                # an edit from deadlocking or writing an old verdict onto the
                # new draft snapshot.
                if work.review_run_id:
                    run_updated = await conn.execute(
                        'UPDATE "research_review_runs" SET '
                        '  "executionStatus" = %s, "outcome" = %s, "summary" = %s::jsonb, '
                        '  "claims" = %s::jsonb, '
                        '  "details" = COALESCE("details", \'{}\'::jsonb) || %s::jsonb, '
                        '  "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "completedAt" = now() '
                        'WHERE "id" = %s AND "executionStatus" = \'reviewing\' '
                        '  AND ("details"->>\'claimToken\') = %s',
                        (
                            "completed" if status_value != "review_unavailable" else "unavailable",
                            summary.get("review_outcome") or (
                                "unavailable" if status_value == "review_unavailable" else None
                            ),
                            json.dumps(summary, ensure_ascii=False),
                            json.dumps(claims, ensure_ascii=False),
                            json.dumps(details, ensure_ascii=False),
                            work.review_run_id,
                            work.claim_token,
                        ),
                    )
                    if run_updated.rowcount != 1:
                        return
                updated = None
                if work.job_id:
                    updated = await conn.execute(
                        sql,
                        (
                            status_value, json.dumps(summary, ensure_ascii=False),
                            json.dumps(claims, ensure_ascii=False),
                            json.dumps(details, ensure_ascii=False), work.job_id, work.claim_token,
                        ),
                    )
                # A review can be reclaimed after a worker crash.  Only the
                # worker that still owns the claim may update the linked draft;
                # otherwise a late result from the old worker would make the
                # draft disagree with the job's newer review snapshot.
                if work.job_id and (updated is None or updated.rowcount != 1):
                    return
                if work.draft_research_id:
                    await conn.execute(
                        draft_sql,
                        (
                            status_value, work.attempts,
                            json.dumps(summary, ensure_ascii=False),
                            json.dumps(claims, ensure_ascii=False),
                            json.dumps(details, ensure_ascii=False),
                            work.draft_research_id,
                        ),
                    )
                # Evidence searches have a second durable handoff: once the
                # review run reaches a terminal state, close the originating
                # claim task even when no browser is polling its endpoint.
                # The Web GET path performs the same transition as a
                # compatibility fallback, so this update is intentionally
                # idempotent and only touches the task attached to this run.
                if work.review_run_id:
                    await conn.execute(
                        'UPDATE "research_evidence_tasks" SET '
                        '  "status" = \'completed\', "completedAt" = now(), '
                        '  "errorCode" = CASE WHEN %s = \'review_unavailable\' '
                        '    THEN \'REVIEW_UNAVAILABLE\' ELSE "errorCode" END, '
                        '  "errorMessage" = CASE WHEN %s = \'review_unavailable\' '
                        '    THEN \'新证据已合并，但这轮事实审核没有完成；原研究稿没有被自动改写。\' '
                        '    ELSE "errorMessage" END '
                        'WHERE "reviewRunId" = %s '
                        '  AND "status" IN (\'review_queued\', \'evidence_ready\')',
                        (status_value, status_value, work.review_run_id),
                    )

    async def release_lease(self, lease: JobLease) -> None:
        await self.open()
        t = f'"{self._table_name}"'
        sql = (
            f"UPDATE {t} "
            f'SET "status" = \'queued\', "lockedBy" = NULL, '
            f'"leaseExpiresAt" = NULL, "heartbeatAt" = NULL, '
            f'"nextRetryAt" = now() + interval \'30 seconds\' '
            f'WHERE "id" = %s AND "lockedBy" = %s AND "status" = \'running\''
        )
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(sql, (lease.job_id, lease.worker_id))

    async def cancel_job(self, job_id: str) -> AiJobStatus | None:
        """Atomically cancel a queued/running job in the durable queue."""
        await self.open()
        t = f'"{self._table_name}"'
        sql = (
            "WITH target AS ("
            f"  SELECT \"id\", \"status\" FROM {t} "
            '  WHERE "id" = %s AND "status" IN (\'queued\', \'running\') '
            "  FOR UPDATE"
            "), updated AS ("
            f"  UPDATE {t} AS j SET "
            '    "status" = \'cancelled\', "completedAt" = now(), '
            '    "lockedBy" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL '
            '  FROM target WHERE j."id" = target."id" '
            '  RETURNING target."status" AS previous_status'
            ") SELECT previous_status FROM updated"
        )
        async with self.pool.connection() as conn:
            async with conn.transaction():
                row = await (await conn.execute(sql, (job_id,))).fetchone()
        if row is None:
            return None
        row_dict = cast(dict[str, object], row)
        return cast(AiJobStatus, str(row_dict["previous_status"]))

    async def get_row(self, job_id: str) -> "DbJobView | None":
        """W2 review 修正:GET /api/ai/jobs/{id} 走 DB 路径,不能依赖 InMemoryJobStore。
        返回 DbJobView,HTTP 层逻辑统一用 .snapshot/.last_sources 等访问。
        """
        await self.open()
        t = f'"{self._table_name}"'
        if self._table_name == IMPORT_TABLE:
            sql = (
                f'SELECT "id", "requesterId", "sourceKind", "status", "attempts", '
                f'       "originalFilename", "mimeType", "sizeBytes", "contentSha256", '
                f'       "sourceUrl", "outputResearchId", "warnings", '
                f'       "errorCode", "errorMessage", "completedAt" '
                f'FROM {t} WHERE "id" = %s'
            )
        else:
            sql = (
                f'SELECT "id", "requesterId", "topic", "context", "reportType", '
                f'       "sourcePolicy", "reportLength", "maxUrlsToScrape", "status", "currentStep", "attempts", '
                f'       "idempotencyKey", "sourceRefs", "partialSources", "failedSources", '
                f'       "tokenInputTotal", "tokenOutputTotal", "costCents", '
                f'       "errorCode", "errorMessage", "errorDetails", "reviewDetails", "startedAt", "createdAt", '
                f'       "completedAt", "draftResearchId", "outputText" '
                f'FROM {t} WHERE "id" = %s'
            )
        async with self.pool.connection() as conn:
            cur = await conn.execute(sql, (job_id,))
            row = await cur.fetchone()
        if row is None:
            return None
        row_dict = cast(dict[str, Any], row)
        if self._table_name == IMPORT_TABLE:
            return DbJobView(
                snapshot=JobSnapshot(
                    job_id=str(row_dict["id"]),
                    requester_id=str(row_dict["requesterId"]),
                    topic=str(row_dict.get("originalFilename", "import") or "import"),
                    context=None,
                    report_type="summary_brief",
                    source_policy="prefer_user_sources",
                    status=cast(AiJobStatus, str(row_dict.get("status", "queued"))),
                    current_step=None,
                    attempts=cast(int, row_dict.get("attempts")) or 0,
                    idempotency_key=None,
                    source_refs=(),
                ),
                last_sources=(),
                last_token_in=0,
                last_token_out=0,
                last_cost_cents=0,
                last_error_code=row_dict.get("errorCode"),
                last_error_message=row_dict.get("errorMessage"),
            )
        partial_sources = row_dict.get("partialSources") or []
        if not isinstance(partial_sources, list):
            partial_sources = []
        failed_sources = row_dict.get("failedSources") or []
        if not isinstance(failed_sources, list):
            failed_sources = []
        view = _view_from_row(row_dict)
        view.draft_research_id = (
            str(row_dict["draftResearchId"])
            if row_dict.get("draftResearchId") is not None
            else None
        )
        return DbJobView(
            snapshot=view.snapshot,
            last_sources=tuple(partial_sources),
            last_failed_sources=tuple(failed_sources),
            last_token_in=int(row_dict.get("tokenInputTotal") or 0),
            last_token_out=int(row_dict.get("tokenOutputTotal") or 0),
            last_cost_cents=int(row_dict.get("costCents") or 0),
            last_error_code=row_dict.get("errorCode"),
            last_error_message=row_dict.get("errorMessage"),
            last_error_details=(row_dict.get("errorDetails") if isinstance(row_dict.get("errorDetails"), dict) else None),
            review_details=(row_dict.get("reviewDetails") if isinstance(row_dict.get("reviewDetails"), dict) else None),
            draft_research_id=view.draft_research_id,
            output_text=(
                str(row_dict["outputText"])
                if row_dict.get("outputText") is not None
                else None
            ),
            started_at=row_dict.get("startedAt"),
            created_at=row_dict.get("createdAt"),
            completed_at=row_dict.get("completedAt"),
        )

    # ─────────────── list + count (history page) ────────────────

    async def list_jobs(
        self,
        *,
        requester_id: str,
        status_filter: tuple[str, ...] | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> Sequence[JobRowView]:
        """Return this user's jobs, newest first.

        `status_filter` is an optional tuple of ``AiJobStatus`` values
        (e.g. ``("queued", "running")``). Implemented as a parameterized
        ``IN (...)`` clause — safe against injection regardless of caller.

        Only meaningful for ``ai_research_jobs``; returns ``[]`` for the
        import table (which has different columns + semantics).
        """
        await self.open()
        if self._table_name != AI_TABLE:
            return []
        t = f'"{self._table_name}"'
        params: list[object] = []
        where = ['j."requesterId" = %s']
        params.append(requester_id)
        if status_filter:
            placeholders = ",".join(["%s"] * len(status_filter))
            where.append(f'j."status" IN ({placeholders})')
            params.extend(status_filter)
        sql = (
            f"SELECT j.\"id\", j.\"requesterId\", j.\"topic\", j.\"context\", "
            f"       j.\"reportType\", j.\"sourcePolicy\", j.\"status\", "
            f"       j.\"reportLength\", j.\"maxUrlsToScrape\", j.\"currentStep\", j.\"attempts\", j.\"idempotencyKey\", "
            f"       j.\"sourceRefs\", j.\"partialSources\", j.\"failedSources\", "
            f"       j.\"tokenInputTotal\", j.\"tokenOutputTotal\", j.\"costCents\", "
            f"       j.\"errorCode\", j.\"errorMessage\", j.\"errorDetails\", j.\"reviewDetails\", j.\"startedAt\", "
            f"       j.\"completedAt\", j.\"createdAt\", j.\"updatedAt\", "
            f"       j.\"draftResearchId\", j.\"outputText\", "
            f"       LEFT(draft.\"body\", 4000) AS \"draftResearchBody\", "
            f"       published.\"id\" AS \"publishedResearchId\" "
            f"FROM {t} j "
            f"LEFT JOIN \"researches\" draft "
            f'  ON draft."id" = j."draftResearchId" '
            f"LEFT JOIN \"researches\" published "
            f'  ON published."id" = j."draftResearchId" AND published."status" = \'published\' '
            f"WHERE {' AND '.join(where)} "
            f"ORDER BY j.\"createdAt\" DESC "
            f"LIMIT %s OFFSET %s"
        )
        params.extend([limit, offset])
        async with self.pool.connection() as conn:
            cur = await conn.execute(sql, tuple(params))
            rows = await cur.fetchall()
        views: list[DbJobView] = []
        for raw in rows:
            row_dict = cast(dict[str, Any], raw)
            view = _view_from_row(row_dict)
            # Hydrate list-only fields. Use getattr() so the view remains
            # compatible with the import / get_row paths that don't set
            # these (slots dataclass does not allow extra kwargs either).
            partial_sources = row_dict.get("partialSources") or []
            view.last_sources = tuple(partial_sources) if isinstance(partial_sources, list) else ()
            failed_sources = row_dict.get("failedSources") or []
            view.last_failed_sources = (
                tuple(failed_sources) if isinstance(failed_sources, list) else ()
            )
            view.last_error_details = (
                row_dict.get("errorDetails")
                if isinstance(row_dict.get("errorDetails"), dict)
                else None
            )
            view.review_details = (
                row_dict.get("reviewDetails")
                if isinstance(row_dict.get("reviewDetails"), dict)
                else None
            )
            view.draft_research_id = (
                str(row_dict["draftResearchId"])
                if row_dict.get("draftResearchId") is not None
                else None
            )
            view.output_text = (
                str(row_dict["outputText"])
                if row_dict.get("outputText") is not None
                else None
            )
            view.draft_research_body = (
                str(row_dict["draftResearchBody"])
                if row_dict.get("draftResearchBody") is not None
                else None
            )
            view.published_research_id = (
                str(row_dict["publishedResearchId"])
                if row_dict.get("publishedResearchId") is not None
                else None
            )
            view.created_at = row_dict.get("createdAt")
            view.started_at = row_dict.get("startedAt")
            view.updated_at = row_dict.get("updatedAt")
            view.completed_at = row_dict.get("completedAt")
            views.append(view)
        return views

    async def count_jobs(
        self,
        *,
        requester_id: str,
        status_filter: tuple[str, ...] | None = None,
    ) -> int:
        """See :meth:`list_jobs` for params."""
        await self.open()
        if self._table_name != AI_TABLE:
            return 0
        t = f'"{self._table_name}"'
        params: list[object] = []
        where = ['"requesterId" = %s']
        params.append(requester_id)
        if status_filter:
            placeholders = ",".join(["%s"] * len(status_filter))
            where.append(f'"status" IN ({placeholders})')
            params.extend(status_filter)
        sql = f"SELECT count(*) AS cnt FROM {t} WHERE {' AND '.join(where)}"
        async with self.pool.connection() as conn:
            row = await (await conn.execute(sql, tuple(params))).fetchone()
        row_data = cast(dict[str, Any] | None, row)
        return int(row_data["cnt"]) if row_data else 0

    # ─────────────── reaper ────────────────

    async def reap_expired_leases(self) -> int:
        await self.open()
        now = _now_utc()
        stale_heartbeat_at = now - timedelta(seconds=self._stale_heartbeat_seconds)
        t = f'"{self._table_name}"'
        # The lease is the authoritative deadline for AI research jobs.
        # gpt-researcher performs a few synchronous provider/search calls;
        # during one of those calls the asyncio loop can be unable to emit a
        # heartbeat even though the worker is still alive and making progress.
        # Reaping on a stale heartbeat alone therefore turns healthy deep
        # research into a partial result before its explicit budget expires.
        # Keep the early stale-heartbeat recovery for the small import worker,
        # where the historical contract is still useful, but never use it to
        # pre-empt an AI research lease that has not actually expired.
        if self._table_name == AI_TABLE:
            recovery_predicate = '"leaseExpiresAt" < %s'
            recovery_params: tuple[object, ...] = (now,)
        else:
            recovery_predicate = (
                '("leaseExpiresAt" < %s OR '
                '("heartbeatAt" IS NOT NULL AND "heartbeatAt" < %s))'
            )
            recovery_params = (now, stale_heartbeat_at)
        # A worker restart must not turn a useful partial investigation into
        # an empty retry. Once the evidence ledger has reached the same floor
        # used by the adapter's partial state, expose it immediately as a
        # recoverable partial result. The user can inspect the sources or run
        # a fresh job; the reaper must not silently discard grounded work.
        sql_partial = ""
        if self._table_name == AI_TABLE:
            sql_partial = (
                f"UPDATE {t} "
                f"SET \"status\" = 'partial', \"errorCode\" = 'WORKER_TIMEOUT', "
                f"    \"errorMessage\" = 'worker lease expired; partial evidence preserved', "
                f"    \"errorDetails\" = jsonb_build_object("
                f"'phase', COALESCE(\"currentStep\"::text, 'unknown'), "
                f"'reason', 'worker_lease_expired', "
                f"'sourcesCount', jsonb_array_length(\"partialSources\")), "
                f"    \"completedAt\" = now(), "
                f"    \"lockedBy\" = NULL, \"leaseExpiresAt\" = NULL, \"heartbeatAt\" = NULL "
                f"WHERE \"status\" = 'running' AND {recovery_predicate} "
                f"  AND jsonb_typeof(\"partialSources\") = 'array' "
                f"  AND jsonb_array_length(\"partialSources\") >= {PARTIAL_MIN_SOURCES} "
                f"RETURNING \"id\""
            )
        sql_failed = (
            f"UPDATE {t} "
            f'SET "status" = \'failed\', "errorCode" = \'WORKER_RETRY_EXHAUSTED\', '
            f'    "errorMessage" = \'reaper: lease expired past WORKER_MAX_RETRIES\', '
            f'    "completedAt" = now(), '
            f'    "lockedBy" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL '
            f'WHERE "status" = \'running\' AND {recovery_predicate} '
            f'  AND "attempts" >= %s '
            f'RETURNING "id"'
        )
        # Retry attempts still start from a clean progress snapshot. Sources
        # remain in ai_research_sources for audit, while queued jobs do not
        # claim to have a current evidence ledger. Jobs with >=3 captured
        # sources were handled by sql_partial above.
        # 注意：这些 AI 专属列仅存在于 ai_research_jobs；
        # content_import_jobs 没有，所以按 table_name 条件拼接。
        ai_reset = ""
        if self._table_name == AI_TABLE:
            ai_reset = (
                ', "partialSources" = \'[]\'::jsonb'
                ', "failedSources" = \'[]\'::jsonb'
                ', "tokenInputTotal" = 0'
                ', "tokenOutputTotal" = 0'
                ', "costCents" = 0'
                ', "outputText" = NULL'
            )
        sql_requeue = (
            f"UPDATE {t} "
            f'SET "status" = \'queued\', "attempts" = "attempts" + 1, '
            f'    "nextRetryAt" = now() + (CASE "attempts" + 1 '
            f"        WHEN 1 THEN '30 seconds'::interval "
            f"        WHEN 2 THEN '120 seconds'::interval "
            f"        WHEN 3 THEN '300 seconds'::interval "
            f"        ELSE '30 seconds'::interval END), "
            f'    "lockedBy" = NULL, "leaseExpiresAt" = NULL, '
            f'    "heartbeatAt" = NULL{ai_reset} '
            f'WHERE "status" = \'running\' AND {recovery_predicate} '
            f'  AND "attempts" < %s '
            f'RETURNING "id"'
        )
        async with self.pool.connection() as conn:
            async with conn.transaction():
                rows_partial: Sequence[object] = ()
                if sql_partial:
                    cur0 = await conn.execute(sql_partial, recovery_params)
                    rows_partial = await cur0.fetchall()
                cur1 = await conn.execute(
                    sql_failed,
                    (*recovery_params, self._max_retries),
                )
                rows_failed = await cur1.fetchall()
                cur2 = await conn.execute(
                    sql_requeue,
                    (*recovery_params, self._max_retries),
                )
                rows_requeued = await cur2.fetchall()
                total = len(rows_partial) + len(rows_failed) + len(rows_requeued)
        if total:
            logger.info(
                "ai-engine.reaper.sweep",
                extra={
                    "partial": len(rows_partial),
                    "failed": len(rows_failed),
                    "requeued": len(rows_requeued),
                    "table": self._table_name,
                },
            )
        return total

    async def start_reaper(
        self, *, interval_seconds: int | None = None
    ) -> asyncio.Task[None]:
        if self._reaper_task is not None and not self._reaper_task.done():
            return self._reaper_task
        interval = interval_seconds or int(
            os.environ.get("WORKER_REAPER_INTERVAL_SECONDS", "30")
        )
        self._reaper_stop.clear()

        async def _loop() -> None:
            while not self._reaper_stop.is_set():
                try:
                    await self.reap_expired_leases()
                except psycopg.Error:
                    logger.warning("ai-engine.reaper.error", exc_info=True)
                except Exception:
                    logger.warning("ai-engine.reaper.unhandled", exc_info=True)
                try:
                    await asyncio.wait_for(self._reaper_stop.wait(), timeout=interval)
                except TimeoutError:
                    continue

        loop = asyncio.get_event_loop()
        self._reaper_task = loop.create_task(_loop(), name=f"reaper-{self._table_name}")
        return self._reaper_task

    # ─────────────── product_events helper ────────────────

    async def record_product_event(
        self,
        *,
        user_id: str,
        event_name: str,
        dedupe_key: str,
        entity_type: str | None = None,
        entity_id: str | None = None,
        metadata: dict[str, object] | None = None,
    ) -> None:
        await self.open()
        sql = (
            'INSERT INTO "product_events" '
            '("userId", "eventName", "entityType", "entityId", "metadata", "dedupeKey", "occurredAt") '
            "VALUES (%s, %s, %s, %s, %s::jsonb, %s, now()) "
            'ON CONFLICT ("dedupeKey") DO NOTHING'
        )
        params = (
            user_id,
            event_name,
            entity_type,
            entity_id,
            json.dumps(metadata or {}, ensure_ascii=False),
            dedupe_key,
        )
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(sql, params)


# 模块末尾:W2 review 加的轻量 view 类,放在 DbJobStore 之后避免
# class 体被误中断。HTTP 层用 .snapshot/.last_sources 等访问。
@dataclass(slots=True)
class DbJobView:
    """DbJobStore.get_row 返回的轻量 view,与 InMemoryJobStore._Row 接口对齐。

    列表接口 (``list_jobs``) 在此之上再带 created_at / updated_at /
    completed_at / elapsed_ms / draft_research_id / published_research_id;
    get_row 与单查路径使用同样的字段集 —— 字段数比接口需求多但 slots
    类没有额外的内存开销,且 SQLite/Postgres 的 row dict 都可以丢进
    同一个 view,SQL 层差异在 list_jobs 的 SELECT 里表达。
    """
    snapshot: JobSnapshot
    last_sources: tuple[object, ...] = ()
    last_failed_sources: tuple[object, ...] = ()
    last_token_in: int = 0
    last_token_out: int = 0
    last_cost_cents: int = 0
    last_error_code: str | None = None
    last_error_message: str | None = None
    last_error_details: dict[str, object] | None = None
    review_details: dict[str, object] | None = None
    # 由 list_jobs 填充,get_row 路径留 None
    draft_research_id: str | None = None
    output_text: str | None = None
    # Only populated by list_jobs; used to classify legacy evidence digests
    # that were persisted as the body of a draft research row.
    draft_research_body: str | None = None
    published_research_id: str | None = None
    started_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    completed_at: datetime | None = None


__all__ = ["DbJobStore", "DbJobView", "AI_TABLE", "IMPORT_TABLE", "SHARED_TABLES"]
