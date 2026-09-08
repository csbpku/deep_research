"""Job runner data models — vendor-agnostic.

These mirror the `ai_research_jobs` columns we touch at runtime
(see `apps/web/prisma/schema.prisma`). We intentionally do NOT import
Prisma types from the Web side — keeping the dependency graph one-way
prevents schema-freeze drift.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Protocol, runtime_checkable

from ai_engine.adapters.base import AdapterSource, CostMetrics
from ai_engine.contracts.states import (
    AiJobStatus,
    AiJobStep,
    ImportStatus,
    ImportSourceKind,
    ReportType,
    SourcePolicy,
)


@dataclass(slots=True, frozen=True)
class JobLease:
    """Lease handle returned by `acquire_next_job`.

    The `expires_at` is computed by the store using
    `WORKER_LEASE_SECONDS`; AI research stores raise it to at least
    `DEEP_RESEARCH_TIMEOUT_SECONDS + 120` (currently 1920s by default).
    Active jobs renew it every 15s, while a restarted worker can reclaim an
    orphan after the lease expires.
    """

    job_id: str
    worker_id: str
    locked_by: str
    lease_expires_at: datetime
    heartbeat_interval_seconds: int


@dataclass(slots=True, frozen=True)
class JobSnapshot:
    """A minimal row view used by the runner — does not leak DB types."""

    job_id: str
    requester_id: str
    topic: str
    context: str | None
    report_type: ReportType
    source_policy: SourcePolicy
    status: AiJobStatus
    current_step: AiJobStep | None
    attempts: int
    idempotency_key: str | None
    source_refs: tuple[dict[str, str | bool], ...]
    report_length: str = "standard"
    max_urls_to_scrape: int | None = None


@dataclass(slots=True, frozen=True)
class ImportJobSnapshot:
    """Minimal row view for content_import_jobs — W3 import worker.

    Mirrors the content_import_jobs columns that the worker touches.
    """

    job_id: str
    requester_id: str
    source_kind: ImportSourceKind
    status: ImportStatus
    original_filename: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    content_sha256: str | None = None
    attempts: int = 0


@dataclass(slots=True, frozen=True)
class HeartbeatResult:
    """Result of a single heartbeat call."""

    renewed: bool
    lease_expires_at: datetime | None
    reason: str | None = None  # populated when `renewed=False`


class LeaseLostError(RuntimeError):
    """Raised when the worker tries to mutate a job whose lease it no
    longer holds (e.g. after expiry and reaper takeover). Mirrors
    `WORKER_LEASE_LOST` (contracts/error-codes.md)."""


@runtime_checkable
class RunnerHooks(Protocol):
    """Hooks the runner calls around execution. The HTTP layer wires this
    to structlog; the spike harness wires it to stdout. Tests pass a
    recording stub."""

    def on_acquired(self, lease: JobLease, snapshot: JobSnapshot) -> None: ...
    def on_step(self, lease: JobLease, step: AiJobStep) -> None: ...
    def on_progress(
        self,
        lease: JobLease,
        *,
        token_in: int,
        token_out: int,
        cost_cents: int,
        sources: tuple[AdapterSource, ...],
    ) -> None: ...
    def on_terminal(
        self,
        lease: JobLease,
        status: AiJobStatus,
        *,
        cost: CostMetrics,
        error_code: str | None,
        error_message: str | None,
    ) -> None: ...
    def on_lease_lost(self, lease: JobLease) -> None: ...


@dataclass(slots=True)
class _NoopHooks:
    """Default no-op hooks for tests that don't care about events."""

    def on_acquired(self, lease: JobLease, snapshot: JobSnapshot) -> None:  # noqa: D401
        pass

    def on_step(self, lease: JobLease, step: AiJobStep) -> None:  # noqa: D401
        pass

    def on_progress(  # noqa: D401
        self,
        lease: JobLease,
        *,
        token_in: int,
        token_out: int,
        cost_cents: int,
        sources: tuple[AdapterSource, ...],
    ) -> None:
        pass

    def on_terminal(  # noqa: D401
        self,
        lease: JobLease,
        status: AiJobStatus,
        *,
        cost: CostMetrics,
        error_code: str | None,
        error_message: str | None,
    ) -> None:
        pass

    def on_lease_lost(self, lease: JobLease) -> None:  # noqa: D401
        pass


def noop_hooks() -> RunnerHooks:
    """Convenience constructor used by the spike harness."""
    return _NoopHooks()


@dataclass(slots=True)
class RunOutcome:
    """Terminal outcome of a single `run_once()` execution.

    The runner does not interpret this — it returns it to the caller
    (HTTP layer in Week 1, the worker loop in Week 5) so the caller can
    decide what to do (re-queue, persist, alert).
    """

    job_id: str
    final_status: AiJobStatus
    cost: CostMetrics
    sources: tuple[AdapterSource, ...]
    current_step: AiJobStep | None
    error_code: str | None = None
    error_message: str | None = None
    error_details: dict[str, object] | None = None
    review_details: dict[str, object] | None = None
    draft_research_id: str | None = None  # only set when final_status=succeeded
    # Inline output is used by lightweight summaries and by partial deep runs
    # that completed a readable report before the worker publication boundary.
    # Partial output is explicitly not a Research draft and remains read-only.
    output_text: str | None = None
    field_metadata: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class ReviewWorkItem:
    """A report handed to the independent fact-review worker.

    Review work is deliberately not represented by ``RunOutcome``.  Research
    execution can finish and become reader-usable while this work is queued,
    retried, or unavailable.  Keeping the two lifecycles separate is what
    prevents a reviewer outage from turning a successful research run into a
    failed job.
    """

    job_id: str
    requester_id: str
    topic: str
    report_type: str
    report: str
    sources: tuple[AdapterSource, ...]
    draft_research_id: str | None
    attempts: int
    review_details: dict[str, object]
    # The durable run is the source of truth for review history.  These
    # fields are copied into the work item so completion can compare-and-set
    # both the run and the legacy job/research mirrors.
    review_run_id: str | None = None
    revision_hash: str | None = None
    source_snapshot_hash: str | None = None
    # A unique claim token makes completion compare-and-set safe.  A stale
    # worker may finish after its row has been reclaimed; it must not overwrite
    # the newer review result on the job or draft.
    claim_token: str = ""
    # A normal run inspects the whole revision. An evidence challenge is a
    # separate, claim-scoped second opinion; it must not silently fall back to
    # rerunning the same full-review path.
    review_mode: Literal["full", "evidence_challenge", "claim_verification"] = "full"
    target_claim: dict[str, object] | None = None
