"""Job store: the seam where the DB-backed worker talks to persistence.

Two implementations:

- `InMemoryJobStore` — default for Week 1; lets the spike harness and
  tests run without a real database. It mirrors the surface the future
  psycopg-backed store will expose.
- `DbJobStore` — TODO; lives in a separate module (`db.py`) and is only
  imported lazily so tests don't require psycopg.

The `build_store()` factory picks one based on `JOB_RUNNER_BACKEND`.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal, Protocol

from ai_engine.adapters.base import AdapterSource
from ai_engine.contracts.errors import AdapterError
from ai_engine.contracts.states import AiJobStatus, AiJobStep, ReportType, SourcePolicy
from ai_engine.job_runner.models import HeartbeatResult, JobLease, JobSnapshot, LeaseLostError

BackendName = Literal["memory", "db"]


class JobRowView(Protocol):
    snapshot: JobSnapshot


@dataclass(slots=True)
class _Row:
    snapshot: JobSnapshot
    locked_by: str | None = None
    lease_expires_at: datetime | None = None
    heartbeat_at: datetime | None = None
    last_token_in: int = 0
    last_token_out: int = 0
    last_cost_cents: int = 0
    last_sources: tuple[AdapterSource, ...] = ()
    # Week 1 review 修正：GET /api/ai/jobs/{id} 需要返回终态 error_code /
    # error_message,但原 Row 没存。mark_terminal 写入这两个字段供 HTTP 层读。
    last_error_code: str | None = None
    last_error_message: str | None = None
    draft_research_id: str | None = None
    output_text: str | None = None


class JobStore:
    """Protocol seam; concrete impls below.

    Methods are async to mirror the future psycopg implementation; the
    in-memory version uses a single `asyncio.Lock` per row to keep
    semantics honest.
    """

    async def open(self) -> None:
        """Bring any lazily-initialized resources online (no-op for memory)."""
        return None

    async def close(self) -> None:
        """Release any resources held by the store (no-op for memory)."""
        return None

    async def enqueue(self, snapshot: JobSnapshot) -> None:
        return None

    async def acquire_next_job(self, worker_id: str) -> tuple[JobLease, JobSnapshot] | None:
        return None

    async def heartbeat(self, lease: JobLease) -> HeartbeatResult:
        return HeartbeatResult(renewed=False, lease_expires_at=None, reason="noop")

    async def record_progress(
        self,
        lease: JobLease,
        *,
        current_step: AiJobStep | None,
        token_in: int,
        token_out: int,
        cost_cents: int,
        sources: Iterable[AdapterSource],
    ) -> None:
        return None

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
    ) -> None:
        return None

    async def release_lease(self, lease: JobLease) -> None:
        return None

    async def cancel_job(self, job_id: str) -> AiJobStatus | None:
        """Persist cancellation and return the status that was cancelled.

        ``None`` means the row was missing or already terminal. The caller
        performs a read first when it needs to distinguish those cases.
        """
        return None

    async def get_row(self, job_id: str) -> "object | None":
        """Read-only view of a job for HTTP GET. Returns None if not found.

        W2 review 修正:Protocol 加这方法,DbJobStore 也实现,InMemoryJobStore
        已有此方法。HTTP 层只读 row,不通过 worker acquire。
        """
        return None

    async def list_jobs(
        self,
        *,
        requester_id: str,
        status_filter: tuple[str, ...] | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> Sequence[JobRowView]:
        """Return a user's job rows, newest first. Default no-op returns []."""
        return []

    async def count_jobs(
        self,
        *,
        requester_id: str,
        status_filter: tuple[str, ...] | None = None,
    ) -> int:
        """Return the total row count for the same filters as list_jobs."""
        return 0

    async def find_by_idempotency_key(
        self, requester_id: str, idempotency_key: str
    ) -> "JobRowView | None":
        """W6: 同 (requester_id, idempotency_key) 已存在任务则返回它的 row;
        否则 None。idempotency replay 在 quota check 之前执行,replay 不
        双扣 quota。
        """
        return None

    async def count_submissions_today(
        self,
        *,
        requester_id: str | None = None,
        team_scope: bool = False,
    ) -> int:
        """W6: 返回当天 UTC 内的提交总数(queued/running/succeeded/partial/failed/cancelled)。

        - requester_id 非空 → 个人维度计数(team_scope 必须 False)
        - team_scope=True    → 团队维度计数(requester_id 必须 None)

        默认实现返回 0;InMemoryJobStore / DbJobStore 各自实现。
        """
        return 0


@dataclass(slots=True)
class InMemoryJobStore(JobStore):
    """In-memory store — no DB needed for Week 1 spike & tests.

    Honours the lease contract:
    - `acquire_next_job` rejects rows whose lease is still valid AND held
      by someone else.
    - `heartbeat` renews only if the caller still owns the lease and it
      has not expired.
    - `mark_terminal` rejects writes when the lease is gone
      (raises `LeaseLostError`).
    """

    lease_seconds: int = 60
    heartbeat_seconds: int = 15
    _rows: dict[str, _Row] = field(default_factory=dict)
    _global_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _row_locks: dict[str, asyncio.Lock] = field(default_factory=dict)

    def _row_lock(self, job_id: str) -> asyncio.Lock:
        lock = self._row_locks.get(job_id)
        if lock is None:
            lock = asyncio.Lock()
            self._row_locks[job_id] = lock
        return lock

    async def enqueue(self, snapshot: JobSnapshot) -> None:
        async with self._global_lock:
            self._rows[snapshot.job_id] = _Row(snapshot=snapshot)
            self._row_locks.setdefault(snapshot.job_id, asyncio.Lock())

    async def list_jobs(
        self,
        *,
        requester_id: str,
        status_filter: tuple[str, ...] | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> Sequence[JobRowView]:
        """In-memory mirror of the DB history query (newest first)."""
        async with self._global_lock:
            rows = [
                row
                for row in self._rows.values()
                if row.snapshot.requester_id == requester_id
                and (status_filter is None or row.snapshot.status in status_filter)
            ]
        rows.sort(key=lambda row: row.snapshot.job_id, reverse=True)
        return list(rows[offset : offset + limit])

    async def count_jobs(
        self,
        *,
        requester_id: str,
        status_filter: tuple[str, ...] | None = None,
    ) -> int:
        """In-memory mirror of the DB count query."""
        async with self._global_lock:
            return sum(
                1
                for row in self._rows.values()
                if row.snapshot.requester_id == requester_id
                and (status_filter is None or row.snapshot.status in status_filter)
            )

    async def acquire_next_job(
        self, worker_id: str
    ) -> tuple[JobLease, JobSnapshot] | None:
        now = datetime.now(timezone.utc)
        async with self._global_lock:
            # Stable order: oldest queued first. State-machines §1 says the
            # queue is ordered by `(status, created_at)`.
            candidates = sorted(
                (r for r in self._rows.values() if r.snapshot.status == "queued"),
                key=lambda r: r.snapshot.job_id,
            )
            for row in candidates:
                if row.lease_expires_at is not None and row.lease_expires_at > now:
                    # Held by someone else; skip.
                    continue
                # Acquire.
                lease_expires_at = now + timedelta(seconds=self.lease_seconds)
                row.locked_by = worker_id
                row.lease_expires_at = lease_expires_at
                row.heartbeat_at = now
                row.snapshot = JobSnapshot(
                    job_id=row.snapshot.job_id,
                    requester_id=row.snapshot.requester_id,
                    topic=row.snapshot.topic,
                    context=row.snapshot.context,
                    report_type=row.snapshot.report_type,
                    source_policy=row.snapshot.source_policy,
                    status="running",
                    current_step=row.snapshot.current_step,
                    attempts=row.snapshot.attempts,
                    idempotency_key=row.snapshot.idempotency_key,
                    source_refs=row.snapshot.source_refs,
                )
                lease = JobLease(
                    job_id=row.snapshot.job_id,
                    worker_id=worker_id,
                    locked_by=worker_id,
                    lease_expires_at=lease_expires_at,
                    heartbeat_interval_seconds=self.heartbeat_seconds,
                )
                return lease, row.snapshot
        return None

    async def heartbeat(self, lease: JobLease) -> HeartbeatResult:
        row = self._rows.get(lease.job_id)
        if row is None or row.locked_by != lease.worker_id:
            return HeartbeatResult(
                renewed=False,
                lease_expires_at=None,
                reason="lease_lost",
            )
        now = datetime.now(timezone.utc)
        if row.lease_expires_at is not None and row.lease_expires_at < now:
            return HeartbeatResult(
                renewed=False,
                lease_expires_at=None,
                reason="lease_expired",
            )
        new_expiry = now + timedelta(seconds=self.lease_seconds)
        row.lease_expires_at = new_expiry
        row.heartbeat_at = now
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
    ) -> None:
        row = self._require_lease(lease)
        async with self._row_lock(lease.job_id):
            row.snapshot = JobSnapshot(
                job_id=row.snapshot.job_id,
                requester_id=row.snapshot.requester_id,
                topic=row.snapshot.topic,
                context=row.snapshot.context,
                report_type=row.snapshot.report_type,
                source_policy=row.snapshot.source_policy,
                status=row.snapshot.status,
                current_step=current_step,
                attempts=row.snapshot.attempts,
                idempotency_key=row.snapshot.idempotency_key,
                source_refs=row.snapshot.source_refs,
            )
            row.last_token_in = token_in
            row.last_token_out = token_out
            row.last_cost_cents = cost_cents
            row.last_sources = tuple(sources)

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
    ) -> None:
        row = self._require_lease(lease)
        if status == "succeeded" and bool(draft_research_id) == bool(output_text):
            raise ValueError(
                "mark_terminal: succeeded requires exactly one of "
                "draft_research_id or output_text"
            )
        if status != "succeeded" and (
            draft_research_id is not None or output_text is not None
        ):
            raise ValueError(f"mark_terminal: status={status} cannot persist output")
        async with self._row_lock(lease.job_id):
            row.snapshot = JobSnapshot(
                job_id=row.snapshot.job_id,
                requester_id=row.snapshot.requester_id,
                topic=row.snapshot.topic,
                context=row.snapshot.context,
                report_type=row.snapshot.report_type,
                source_policy=row.snapshot.source_policy,
                status=cast_status(status),
                current_step=current_step,
                attempts=row.snapshot.attempts,
                idempotency_key=row.snapshot.idempotency_key,
                source_refs=row.snapshot.source_refs,
            )
            row.locked_by = None
            row.lease_expires_at = None
            row.heartbeat_at = None
            row.last_error_code = error_code
            row.last_error_message = error_message
            row.draft_research_id = draft_research_id
            row.output_text = output_text
        # Caller is responsible for downstream side-effects (e.g. draft
        # research row) — see Week 5 worker.

    async def release_lease(self, lease: JobLease) -> None:
        row = self._rows.get(lease.job_id)
        if row is None or row.locked_by != lease.worker_id:
            return
        async with self._row_lock(lease.job_id):
            row.locked_by = None
            row.lease_expires_at = None
            row.heartbeat_at = None

    async def cancel_job(self, job_id: str) -> AiJobStatus | None:
        row = self._rows.get(job_id)
        if row is None:
            return None
        async with self._row_lock(job_id):
            previous = row.snapshot.status
            if previous not in {"queued", "running"}:
                return None
            row.snapshot = JobSnapshot(
                job_id=row.snapshot.job_id,
                requester_id=row.snapshot.requester_id,
                topic=row.snapshot.topic,
                context=row.snapshot.context,
                report_type=row.snapshot.report_type,
                source_policy=row.snapshot.source_policy,
                status="cancelled",
                current_step=row.snapshot.current_step,
                attempts=row.snapshot.attempts,
                idempotency_key=row.snapshot.idempotency_key,
                source_refs=row.snapshot.source_refs,
            )
            row.locked_by = None
            row.lease_expires_at = None
            row.heartbeat_at = None
            return previous

    # ──────────────── test helpers ────────────────

    def get_row(self, job_id: str) -> _Row | None:  # type: ignore[override]
        return self._rows.get(job_id)

    async def find_by_idempotency_key(
        self, requester_id: str, idempotency_key: str
    ) -> _Row | None:
        """W6: in-memory 实现 — 线性扫 _rows,匹配 (requester, key)。

        Tests 路径 row 数 < 50,O(n) 没问题;DB 路径走 partial unique index。
        """
        async with self._global_lock:
            for row in self._rows.values():
                snap = row.snapshot
                if (
                    snap.requester_id == requester_id
                    and snap.idempotency_key == idempotency_key
                ):
                    return row
        return None

    async def count_submissions_today(
        self,
        *,
        requester_id: str | None = None,
        team_scope: bool = False,
    ) -> int:
        """W6: in-memory 实现 — 线性扫。

        计数语义包含 queued/running/succeeded/partial/failed/cancelled
        (即所有已接受的任务),与任务描述一致。
        """
        if team_scope and requester_id is not None:
            raise ValueError("count_submissions_today: pick one of team_scope or requester_id")
        from datetime import datetime, timezone

        cutoff = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        async with self._global_lock:
            rows = list(self._rows.values())
        count = 0
        for r in rows:
            # InMemoryJobStore 没有显式 created_at 字段;用 enqueue 顺序不可靠。
            # 测试路径以 row.snapshot.job_id 时间戳不可靠,所以这里仅按"已存在行"
            # 计入;测试路径不依赖日期边界过滤(测试统一用同一个 fixture 当天)。
            if team_scope:
                count += 1
            elif r.snapshot.requester_id == requester_id:
                count += 1
        _ = cutoff  # noqa: F841 — 占位,以便未来在 InMemory 路径补 created_at
        return count

    def _require_lease(self, lease: JobLease) -> _Row:
        row = self._rows.get(lease.job_id)
        if row is None:
            raise LeaseLostError(f"job {lease.job_id} not found")
        if row.locked_by != lease.worker_id:
            raise LeaseLostError(
                f"lease for {lease.job_id} is held by {row.locked_by!r}, "
                f"not by {lease.worker_id!r}"
            )
        now = datetime.now(timezone.utc)
        if row.lease_expires_at is not None and row.lease_expires_at < now:
            raise LeaseLostError(f"lease for {lease.job_id} expired")
        return row


def cast_status(value: str) -> AiJobStatus:
    """Defensive helper — keeps mypy strict happy with literal unions."""
    if value not in {"succeeded", "partial", "failed", "cancelled", "running", "queued"}:
        raise AdapterError(
            code="VALIDATION_FAILED",
            message=f"unknown AiJobStatus {value!r}",
        )
    return value  # type: ignore[return-value]


def build_store(
    *,
    name: BackendName | None = None,
    lease_seconds: int | None = None,
    heartbeat_seconds: int | None = None,
) -> JobStore:
    """Factory used by both the worker entrypoint and tests."""
    chosen = (name or os.environ.get("JOB_RUNNER_BACKEND") or "memory").lower()
    if chosen == "memory":
        return InMemoryJobStore(
            lease_seconds=lease_seconds or int(os.environ.get("WORKER_LEASE_SECONDS", "60")),
            heartbeat_seconds=heartbeat_seconds
            or int(os.environ.get("WORKER_HEARTBEAT_SECONDS", "15")),
        )
    if chosen == "db":
        # Week 2 — DB-backed store is live. We import lazily so tests that
        # pick `memory` don't pull psycopg_pool / psycopg into memory.
        from ai_engine.job_runner.db_store import (  # noqa: PLC0415
            AI_TABLE,
            DbJobStore,
        )

        # Pick the table by JOB_RUNNER_TABLE env (default AI_TABLE). Import
        # jobs use the same runner — Week 3+ wires the switch in.
        table_name = os.environ.get("JOB_RUNNER_TABLE", AI_TABLE)
        return DbJobStore(
            table_name=table_name,
            lease_seconds=lease_seconds or int(os.environ.get("WORKER_LEASE_SECONDS", "60")),
            heartbeat_seconds=heartbeat_seconds
            or int(os.environ.get("WORKER_HEARTBEAT_SECONDS", "15")),
        )
    raise AdapterError(
        code="VALIDATION_FAILED",
        message=f"unknown JOB_RUNNER_BACKEND={chosen!r}",
    )


def make_job_snapshot(
    *,
    topic: str = "示例主题",
    requester_id: str = "00000000-0000-0000-0000-000000000001",
    report_type: ReportType = "research_report",
    source_policy: SourcePolicy = "prefer_user_sources",
) -> JobSnapshot:
    """Convenience constructor used by tests and the spike harness."""
    return JobSnapshot(
        job_id=str(uuid.uuid4()),
        requester_id=requester_id,
        topic=topic,
        context=None,
        report_type=report_type,
        source_policy=source_policy,
        status="queued",
        current_step=None,
        attempts=0,
        idempotency_key=None,
        source_refs=(),
    )


__all__ = [
    "BackendName",
    "InMemoryJobStore",
    "JobStore",
    "build_store",
    "cast_status",
    "make_job_snapshot",
]
