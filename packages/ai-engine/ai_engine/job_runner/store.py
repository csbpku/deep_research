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
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal

from ai_engine.adapters.base import AdapterSource
from ai_engine.contracts.errors import AdapterError
from ai_engine.contracts.states import AiJobStatus, AiJobStep, ReportType, SourcePolicy
from ai_engine.job_runner.models import HeartbeatResult, JobLease, JobSnapshot, LeaseLostError

BackendName = Literal["memory", "db"]


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


class JobStore:
    """Protocol seam; concrete impls below.

    Methods are async to mirror the future psycopg implementation; the
    in-memory version uses a single `asyncio.Lock` per row to keep
    semantics honest.
    """

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
    ) -> None:
        return None

    async def release_lease(self, lease: JobLease) -> None:
        return None


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

    # ──────────────── test helpers ────────────────

    def get_row(self, job_id: str) -> _Row | None:
        return self._rows.get(job_id)

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
        # Week 5 — until then, fail loudly so misconfig is caught at startup.
        raise AdapterError(
            code="NOT_IMPLEMENTED",
            message=(
                "DB-backed job store is Week 5 work. "
                "Use JOB_RUNNER_BACKEND=memory for the Week 1 skeleton."
            ),
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