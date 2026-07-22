"""Top-level runner — `run_once()` ties a store + adapter together.

This is the function the HTTP layer (Week 1) and the polling worker
(Week 5) call. It returns a `RunOutcome` and never raises on terminal
job errors — those are encoded in the outcome (so callers can decide
whether to retry, surface to UI, etc.).

The runner is intentionally lean in Week 1:
- It does NOT spawn a draft research row on success — Week 5 worker
  owns that side-effect (and the `creation_method='ai_research'` +
  `origin_content_sha256` rules, see state-machines §7).
- It does NOT persist anything to the DB; `mark_terminal` is a hook on
  the store, and the in-memory store just records the terminal status.

This module also exposes a polling-friendly helper `run_one_available_job`
which is what the spike harness uses.
"""

from __future__ import annotations

import asyncio
import os
import socket
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from ai_engine.adapters.base import (
    AdapterSource,
    AdapterStatus,
    CostMetrics,
    ResearchEngineAdapter,
    ResearchRequest,
)
from ai_engine.contracts.errors import AdapterError
from ai_engine.contracts.states import (
    AI_JOB_STATUS,
    PARTIAL_MIN_SOURCES,
    AiJobStatus,
)
from ai_engine.job_runner.models import (
    JobLease,
    JobSnapshot,
    RunOutcome,
    RunnerHooks,
    noop_hooks,
)
from ai_engine.job_runner.store import JobStore, cast_status


def _default_worker_id() -> str:
    """Stable worker id used by `run_one_available_job`.

    Format: `<hostname>-<pid>` — same convention as Postgres advisory
    locks, so logs are easy to correlate across machines.
    """
    return f"{socket.gethostname()}-{os.getpid()}"


async def run_once(
    *,
    store: JobStore,
    adapter: ResearchEngineAdapter,
    lease: JobLease,
    snapshot: JobSnapshot,
    hooks: RunnerHooks | None = None,
    draft_factory: "Callable[[JobSnapshot, tuple[AdapterSource, ...]], Awaitable[str | None]] | None" = None,
) -> RunOutcome:
    """Execute one acquired job end-to-end.

    Steps:
    1. Submit to adapter if not already submitted (idempotent on `job_id`).
    2. Poll adapter status, calling `record_progress` and emitting hooks.
    3. Translate final status → `mark_terminal` on the store.
    """
    hooks = hooks or noop_hooks()
    hooks.on_acquired(lease, snapshot)

    request = ResearchRequest(
        job_id=lease.job_id,
        request_id=lease.job_id,  # the engine uses job_id as its own trace id
        topic=snapshot.topic,
        context=snapshot.context,
        report_type=snapshot.report_type,
        source_policy=snapshot.source_policy,
        source_refs=snapshot.source_refs,
        timeout_seconds=int(os.environ.get("WORKER_JOB_TIMEOUT_SECONDS", "300")),
    )

    try:
        await adapter.submit(request)
    except AdapterError:
        # Adapter refused — most likely duplicate submit (idempotent on
        # job_id). We still poll get_status below.
        pass

    # Poll until terminal. Cap iterations to keep tests fast.
    deadline_monotonic = asyncio.get_event_loop().time() + request.timeout_seconds
    terminal: AdapterStatus | None = None
    while True:
        try:
            status = await adapter.get_status(lease.job_id)
        except AdapterError as exc:
            if exc.code == "AI_JOB_NOT_FOUND":
                # Adapter restarted and lost our job — treat as failed.
                await store.mark_terminal(
                    lease,
                    "failed",
                    current_step=None,
                    error_code=exc.code,
                    error_message=exc.message,
                    draft_research_id=None,
                )
                hooks.on_terminal(
                    lease,
                    "failed",
                    cost=_zero_cost(),
                    error_code=exc.code,
                    error_message=exc.message,
                )
                return RunOutcome(
                    job_id=lease.job_id,
                    final_status="failed",
                    cost=_zero_cost(),
                    sources=(),
                    current_step=None,
                    error_code=exc.code,
                    error_message=exc.message,
                )
            raise
        if status.status in (
            AI_JOB_STATUS["SUCCEEDED"],
            AI_JOB_STATUS["PARTIAL"],
            AI_JOB_STATUS["FAILED"],
            AI_JOB_STATUS["CANCELLED"],
        ):
            # Week 1 review 修正：终态 poll 必须 record_progress 一次,否则
            # row.last_sources 只反映第一次 poll(空),fake adapter 的
            # sources 在 asyncio.create_task 完成时才填,runner 先 break 跳出
            # 就丢失了终态 sources。
            await store.record_progress(
                lease,
                current_step=status.current_step,
                token_in=status.cost.token_input_total,
                token_out=status.cost.token_output_total,
                cost_cents=status.cost.cost_cents,
                sources=status.sources,
            )
            terminal = status
            break
        # Notify progress.
        if status.current_step is not None:
            hooks.on_step(lease, status.current_step)
        hooks.on_progress(
            lease,
            token_in=status.cost.token_input_total,
            token_out=status.cost.token_output_total,
            cost_cents=status.cost.cost_cents,
            sources=status.sources,
        )
        await store.record_progress(
            lease,
            current_step=status.current_step,
            token_in=status.cost.token_input_total,
            token_out=status.cost.token_output_total,
            cost_cents=status.cost.cost_cents,
            sources=status.sources,
        )
        if asyncio.get_event_loop().time() >= deadline_monotonic:
            # Adapter is still running past our budget → lease lost.
            hooks.on_lease_lost(lease)
            await store.mark_terminal(
                lease,
                "failed",
                current_step=status.current_step,
                error_code="WORKER_TIMEOUT",
                error_message="worker exceeded job budget",
                draft_research_id=None,
            )
            return RunOutcome(
                job_id=lease.job_id,
                final_status="failed",
                cost=status.cost,
                sources=status.sources,
                current_step=status.current_step,
                error_code="WORKER_TIMEOUT",
                error_message="worker exceeded job budget",
            )
        await asyncio.sleep(0.05 if os.environ.get("AI_ENGINE_TEST_FAST_POLL") else 0.5)

    assert terminal is not None  # noqa: S101 — for mypy

    final_status: AiJobStatus = terminal.status
    draft_id: str | None = None
    sources_tuple: tuple[AdapterSource, ...] = terminal.sources
    if final_status == AI_JOB_STATUS["SUCCEEDED"]:
        # W2 review 修正:schema CHECK 强制 succeeded 时 draftResearchId NOT NULL
        # + FK 指向 researches.id。Runner 不再自造 UUID sentinel;改为调
        # draft_factory 由 caller(adapter / worker / HTTP layer)负责真
        # INSERT 一条 research row 拿真 id。
        # 默认 fallback:写 _drafts_for_tests dict 拿 uuid,允许 InMemory 测试路径。
        # 生产部署必须显式传 draft_factory 直连 DB;这由 caller(server app)在
        # lifespan 里决定。
        if draft_factory is None:
            from ai_engine.job_runner.db_store import _drafts_for_tests  # type: ignore
            import uuid as _uuid
            draft_id = str(_uuid.uuid4())
            _drafts_for_tests[draft_id] = {
                "topic": snapshot.topic,
                "requester_id": snapshot.requester_id,
                "sources": len(sources_tuple),
                "via": "default_factory",
            }
        else:
            draft_id = await draft_factory(snapshot, sources_tuple)
            if not draft_id:
                raise ValueError(
                    "run_once: draft_factory returned None for succeeded job; "
                    "must INSERT a research row and return its id."
                )

    await store.mark_terminal(
        lease,
        cast_status(final_status),  # type: ignore[arg-type]
        current_step=terminal.current_step,
        error_code=terminal.error_code,
        error_message=terminal.error_message,
        draft_research_id=draft_id,
    )
    hooks.on_terminal(
        lease,
        final_status,
        cost=terminal.cost,
        error_code=terminal.error_code,
        error_message=terminal.error_message,
    )

    return RunOutcome(
        job_id=lease.job_id,
        final_status=final_status,
        cost=terminal.cost,
        sources=terminal.sources,
        current_step=terminal.current_step,
        error_code=terminal.error_code,
        error_message=terminal.error_message,
        draft_research_id=draft_id,
        field_metadata={
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "search_count": str(terminal.cost.search_count),
        },
    )


async def run_one_available_job(
    *,
    store: JobStore,
    adapter: ResearchEngineAdapter,
    worker_id: str | None = None,
    hooks: RunnerHooks | None = None,
    draft_factory: Callable[[JobSnapshot, tuple[AdapterSource, ...]], Awaitable[str | None]] | None = None,
) -> RunOutcome | None:
    """Acquire + execute one job; return None if the queue is empty.

    The spike harness uses this; the Week 5 worker wraps it in a
    forever-loop.
    """
    wid = worker_id or _default_worker_id()
    acquired = await store.acquire_next_job(wid)
    if acquired is None:
        return None
    lease, snapshot = acquired
    return await run_once(
        store=store, adapter=adapter, lease=lease, snapshot=snapshot,
        hooks=hooks, draft_factory=draft_factory,
    )


def _zero_cost() -> CostMetrics:
    return CostMetrics(
        token_input_total=0,
        token_output_total=0,
        cost_cents=0,
        search_count=0,
    )


__all__ = ["run_once", "run_one_available_job"]


# Touch AiJobStep / AiJobStatus / PARTIAL_MIN_SOURCES so import isn't
# flagged as unused — these are referenced in the docstring and tests.
_ = (AiJobStatus, PARTIAL_MIN_SOURCES, AdapterSource)