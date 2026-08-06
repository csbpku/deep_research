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
from ai_engine.contracts.states import AiJobStatus, AiJobStep
from ai_engine.job_runner.models import (
    HeartbeatResult,
    JobLease,
    JobSnapshot,
    LeaseLostError,
)
from ai_engine.job_runner.store import JobRowView, JobStore

logger = logging.getLogger("ai_engine.job_runner.db_store")

AI_TABLE = "ai_research_jobs"
IMPORT_TABLE = "content_import_jobs"
SHARED_TABLES: tuple[str, ...] = (AI_TABLE, IMPORT_TABLE)

# W2 review 修正:InMemoryJobStore 测试路径(无真 DB)succeeded 时,
# 工厂把 fake draft id 写到这里,让 runner 拿到非 None id。生产不依赖。
_drafts_for_tests: dict[str, dict[str, object]] = {}


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
    return JobSnapshot(
        job_id=str(row["id"]),
        requester_id=str(row["requesterId"]),
        topic=str(row["topic"]),
        context=context_str,
        report_type=cast(
            Literal["research_report", "summary_brief"],
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
        self._lease_seconds = lease_seconds or int(
            os.environ.get("WORKER_LEASE_SECONDS", "60")
        )
        self._heartbeat_seconds = heartbeat_seconds or int(
            os.environ.get("WORKER_HEARTBEAT_SECONDS", "15")
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
                resolved["resolvedSnippet"] = str(
                    found_dict.get("interpretation") or found_dict.get("body") or ""
                )[:4000]
                if found_dict.get("url"):
                    resolved["resolvedUrl"] = str(found_dict["url"])[:2000]
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
                f'("id", "requesterId", "topic", "context", "reportType", "sourcePolicy", '
                f'"status", "currentStep", "attempts", "idempotencyKey", "sourceRefs", '
                f'"partialSources", "failedSources", "updatedAt") '
                f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, now()) "
                f"ON CONFLICT (id) DO NOTHING"
            )
            ai_params: tuple[object, ...] = (
                snapshot.job_id,
                snapshot.requester_id,
                snapshot.topic,
                snapshot.context,
                snapshot.report_type,
                snapshot.source_policy,
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
            f"j.\"reportType\", j.\"sourcePolicy\", j.\"status\", j.\"currentStep\", "
            f"j.\"attempts\", j.\"idempotencyKey\", j.\"sourceRefs\" "
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
                'j."sourcePolicy", j."status", j."currentStep", j."attempts", '
                'j."idempotencyKey", j."sourceRefs"'
            )

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
            f"SET \"status\" = 'running', "
            f'    "lockedBy" = %s, '
            f'    "leaseExpiresAt" = %s, '
            f'    "heartbeatAt" = %s '
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
    ) -> None:
        # content_import_jobs doesn't have currentStep / tokenInputTotal / partialSources
        # columns — record_progress is a no-op for the import table. The import worker
        # writes outputResearchId and status via mark_terminal.
        if self._table_name == IMPORT_TABLE:
            return
        await self.open()
        sources_json = json.dumps(
            [
                {
                    "source_ref": s.source_ref,
                    "canonical_key": s.canonical_key,
                    "title": s.title,
                    "snippet": s.snippet,
                    "score": s.score,
                    "step_captured": s.step_captured,
                    "is_accessible": s.is_accessible,
                }
                for s in sources
            ],
            ensure_ascii=False,
        )
        t = f'"{self._table_name}"'
        sql = (
            f"UPDATE {t} "
            f'SET "currentStep" = %s, "tokenInputTotal" = %s, "tokenOutputTotal" = %s, '
            f'    "costCents" = %s, "partialSources" = %s::jsonb, "reviewDetails" = %s::jsonb '
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
                        lease.job_id,
                        lease.worker_id,
                    ),
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
            # A succeeded research_report owns a draft; a succeeded
            # summary_brief owns inline output. They are mutually exclusive.
            if status == "succeeded" and bool(draft_research_id) == bool(output_text):
                raise ValueError(
                    "mark_terminal: succeeded requires exactly one of "
                    "draft_research_id or output_text"
                )
            if status != "succeeded" and (
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
                    "contradicted_count": review_details.get("contradicted_count", 0),
                }
                if review_details
                else None
            )
            review_claims = review_details.get("claims", []) if review_details else []
            sql = (
                f"UPDATE {t} "
                f'SET "status" = %s, "currentStep" = %s, "errorCode" = %s, "errorMessage" = %s, "errorDetails" = %s::jsonb, '
                f'    "reviewStatus" = %s, "reviewAttempts" = %s, "reviewSummary" = %s::jsonb, "reviewClaims" = %s::jsonb, "reviewedAt" = now(), "reviewDetails" = %s::jsonb, '
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
                f'       "sourcePolicy", "status", "currentStep", "attempts", '
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
            f"       j.\"currentStep\", j.\"attempts\", j.\"idempotencyKey\", "
            f"       j.\"sourceRefs\", j.\"partialSources\", j.\"failedSources\", "
            f"       j.\"tokenInputTotal\", j.\"tokenOutputTotal\", j.\"costCents\", "
            f"       j.\"errorCode\", j.\"errorMessage\", j.\"errorDetails\", j.\"reviewDetails\", j.\"startedAt\", "
            f"       j.\"completedAt\", j.\"createdAt\", j.\"updatedAt\", "
            f"       j.\"draftResearchId\", "
            f"       r.\"id\" AS \"publishedResearchId\" "
            f"FROM {t} j "
            f"LEFT JOIN \"researches\" r "
            f'  ON r."id" = j."draftResearchId" AND r."status" = \'published\' '
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
        t = f'"{self._table_name}"'
        sql_failed = (
            f"UPDATE {t} "
            f'SET "status" = \'failed\', "errorCode" = \'WORKER_RETRY_EXHAUSTED\', '
            f'    "errorMessage" = \'reaper: lease expired past WORKER_MAX_RETRIES\', '
            f'    "completedAt" = now(), '
            f'    "lockedBy" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL '
            f'WHERE "status" = \'running\' AND "leaseExpiresAt" < %s '
            f'  AND "attempts" >= %s '
            f'RETURNING "id"'
        )
        # W9 code review 修订：此前 requeue 只重置 status/attempts/lockedBy/lease，
        # 但不清除 partialSources / failedSources / tokenTotal / costCents。
        # 多次重试后前一次的 JSON 片段和 token 计数累积在列里，导致
        # 「≥3 个来源才记 succeeded」的校验可能被陈旧数据凑够。
        # 每个 attempt 应该从干净状态开始。
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
            f'WHERE "status" = \'running\' AND "leaseExpiresAt" < %s '
            f'  AND "attempts" < %s '
            f'RETURNING "id"'
        )
        async with self.pool.connection() as conn:
            async with conn.transaction():
                cur1 = await conn.execute(sql_failed, (now, self._max_retries))
                rows_failed = await cur1.fetchall()
                cur2 = await conn.execute(sql_requeue, (now, self._max_retries))
                rows_requeued = await cur2.fetchall()
                total = len(rows_failed) + len(rows_requeued)
        if total:
            logger.info(
                "ai-engine.reaper.sweep",
                extra={
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
    published_research_id: str | None = None
    started_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    completed_at: datetime | None = None


__all__ = ["DbJobStore", "DbJobView", "AI_TABLE", "IMPORT_TABLE", "SHARED_TABLES"]
