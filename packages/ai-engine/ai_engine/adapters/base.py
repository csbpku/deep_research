"""Adapter Protocol and DTOs.

The Protocol describes the contract that the Week 5 worker, the Week 2
summary ingestion, and the test suite all depend on. Implementations live
in sibling modules (`fake.py`, `claude.py`, `gpt_researcher.py`).

Why Protocol + DTOs and not concrete classes:
- The business layer must not depend on a vendor's data shape
  (gpt-researcher returns `ResearchResult` / `Source` / `Cost`; claude-sdk
   returns `Message` / `Usage`). DTOs are the contract.
- Duck-typing keeps the fake adapter cheap to instantiate in tests.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from ai_engine.contracts.errors import AdapterError
from ai_engine.contracts.states import (
    AiJobStep,
    AiJobStatus,
    CreationMethod,
    ReportType,
    SourcePolicy,
)


# Source-ref union — mirrors packages/shared/src/schemas.ts `SourceRefUrl`
# plus the discriminated variants for favorite/research/summary ids.
SourceRef = dict[str, str | bool]


@dataclass(slots=True, frozen=True)
class ResearchRequest:
    """Adapter-agnostic research request.

    The adapter receives only fields it must care about — the DB row stays
    in the worker. `request_id` is the trace id from the BFF (no PII).
    """

    job_id: str
    request_id: str
    topic: str
    context: str | None
    report_type: ReportType
    source_policy: SourcePolicy
    source_refs: tuple[SourceRef, ...]
    # Hint from the worker about expected max latency. Adapter should raise
    # AdapterError(code=WORKER_TIMEOUT) past this. Default 5 min — see
    # ARCHITECTURE §四.
    timeout_seconds: int = 300


@dataclass(slots=True, frozen=True)
class AdapterSource:
    """One captured source — vendor-agnostic.

    `canonical_key` is the dedupe key (URL, DOI, arxiv id, or internal uuid).
    `score` is optional relevance score in [0, 1].
    `step_captured` tells the worker which step produced this source so it
    can populate `ai_research_sources.step_captured` (see schema).
    """

    source_ref: SourceRef
    canonical_key: str
    title: str | None
    snippet: str | None
    score: float | None
    step_captured: AiJobStep
    is_accessible: bool = True  # HEAD probe result


@dataclass(slots=True, frozen=True)
class CostMetrics:
    """Token & cost snapshot. Numeric only — never content."""

    token_input_total: int
    token_output_total: int
    cost_cents: int
    search_count: int


@dataclass(slots=True, frozen=True)
class AdapterStatus:
    """Snapshot returned by `get_status()`."""

    job_id: str
    status: AiJobStatus
    current_step: AiJobStep | None
    attempts: int
    sources: tuple[AdapterSource, ...]
    cost: CostMetrics
    error_code: str | None = None
    error_message: str | None = None  # MUST be redacted; never raw stack.
    output_text: str | None = None


@dataclass(slots=True, frozen=True)
class AdapterCancelOutcome:
    """Cancel result. `was_running=True` means the adapter was actively
    executing; the worker should mark the job `cancelled` (only if queued
    — running is interrupted and reaper takes over, per state-machines §1).
    """

    was_queued: bool
    was_running: bool
    job_id: str


@dataclass(slots=True, frozen=True)
class AdapterHealth:
    """Probe result for `/healthz`."""

    ok: bool
    adapter_name: str
    details: dict[str, str] = field(default_factory=dict)


@runtime_checkable
class ResearchEngineAdapter(Protocol):
    """Vendor-agnostic engine contract.

    All methods are async because the worker and HTTP layer are async.
    Implementations are free to block internally as long as they respect
    `timeout_seconds`.
    """

    name: str

    async def submit(self, request: ResearchRequest) -> str:
        """Queue a job. Returns the adapter-local job id.

        The worker treats the returned id as opaque and stores it on the
        `ai_research_jobs` row (no DB column for it yet — Week 5 adds one
        if needed). For the Week 1 skeleton we reuse `job_id`.
        """
        ...

    async def get_status(self, job_id: str) -> AdapterStatus:
        """Read current status. Raises AdapterError(AI_JOB_NOT_FOUND) if absent."""
        ...

    async def cancel(self, job_id: str) -> AdapterCancelOutcome:
        """Cancel a queued job. Raises AdapterError(AI_JOB_NOT_CANCELLABLE)
        for terminal states."""
        ...

    async def health(self) -> AdapterHealth:
        """Liveness probe. Returns AdapterHealth(ok=False) — not raise —
        for transient unavailability so `/healthz` can render 503 cleanly."""
        ...


# `creation_method` enum string literal set — mirrors `packages/shared`.
# Re-exported so adapter code doesn't have to import from contracts.states
# for the literal type alias.
CreationMethodLiteral = CreationMethod  # type alias for clarity


def build_adapter(name: str | None = None) -> ResearchEngineAdapter:
    """Factory selected by `AI_ENGINE_ADAPTER` env var (default: `fake`).

    The factory keeps the engine entry point explicit and easy to mock. It
    is the only place that imports concrete adapter classes — keeping the
    lazy import means missing optional deps (claude-sdk, gpt-researcher)
    surface as ImportError at startup, not at import time of `adapters`.
    """
    chosen = (name or os.environ.get("AI_ENGINE_ADAPTER") or "fake").lower()
    if chosen == "fake":
        from ai_engine.adapters.fake import FakeAdapter

        return FakeAdapter()
    if chosen == "claude":
        # Week 2 — real Claude adapter via Anthropic SDK (ADR 0004 #1/#5).
        # Defaults to ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL + ANTHROPIC_MODEL
        # from env so cc-switch works out of the box.
        from ai_engine.adapters.claude import ClaudeAdapter

        return ClaudeAdapter()
    if chosen == "gpt_researcher":
        raise AdapterError(
            code="NOT_IMPLEMENTED",
            message="gpt-researcher was rejected by ADR 0004 — not implemented.",
            request_id=None,
        )
    raise AdapterError(
        code="VALIDATION_FAILED",
        message=f"unknown AI_ENGINE_ADAPTER={chosen!r}",
        request_id=None,
    )
