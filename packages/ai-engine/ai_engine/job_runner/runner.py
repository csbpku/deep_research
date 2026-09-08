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
from typing import Literal, Mapping

from ai_engine.adapters.base import (
    AdapterSource,
    AdapterStatus,
    CostMetrics,
    ResearchEngineAdapter,
    ResearchRequest,
)
from ai_engine.contracts.artifacts import ArtifactType, render_artifact_content
from ai_engine.contracts.errors import AdapterError
from ai_engine.contracts.states import (
    AI_JOB_STATUS,
    PARTIAL_MIN_SOURCES,
    AiJobStatus,
    AiJobStep,
)
from ai_engine.job_runner.models import (
    JobLease,
    JobSnapshot,
    LeaseLostError,
    RunOutcome,
    RunnerHooks,
    noop_hooks,
)
from ai_engine.job_runner.store import JobStore, cast_status


def _review_details(metadata: dict[str, object] | None) -> dict[str, object] | None:
    """Persist review data and the live deep-research checkpoint.

    ``reviewDetails`` predates the live research checkpoint, so it remains the
    durable JSON channel for both.  Keep the final review fields at the top
    level for existing consumers and namespace the in-flight progress to avoid
    confusing it with fact-review status.
    """
    if not metadata:
        return None
    value = metadata.get("review")
    progress = metadata.get("research_progress")
    if not isinstance(value, dict) and not isinstance(progress, dict):
        return None
    persisted = dict(value) if isinstance(value, dict) else {}
    if isinstance(progress, dict):
        persisted["research_progress"] = progress
    return persisted


def _metadata_int(metadata: dict[str, object] | None, key: str, default: int = 0) -> int:
    if not metadata:
        return default
    value = metadata.get(key, default)
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


def _default_worker_id() -> str:
    """Stable worker id used by `run_one_available_job`.

    Format: `<hostname>-<pid>` — same convention as Postgres advisory
    locks, so logs are easy to correlate across machines.
    """
    return f"{socket.gethostname()}-{os.getpid()}"


def _resolve_worker_timeout(report_length: str, env: Mapping[str, str] | None = None) -> int:
    """Resolve the job budget without treating deep research like a brief.

    A deep run has a bounded research tree plus report writing and evidence
    review. The old global five-minute budget routinely expired after the
    search tree had finished, which discarded useful work at the publication
    boundary. Keep the normal budget unchanged, give deep runs a calibrated
    default, and retain an explicit operator override for local/test runs.
    """
    values = os.environ if env is None else env

    def positive_int(name: str, default: int) -> int:
        raw = values.get(name)
        if raw is None:
            return default
        try:
            parsed = int(raw)
        except (TypeError, ValueError):
            return default
        return parsed if parsed > 0 else default

    if str(report_length).strip().lower() == "deep":
        # Deep research has a separate publication boundary: the search tree
        # can be useful and complete while writing/reviewing still needs time.
        # Prefer its explicit budget, then fall back to the generic worker
        # setting for backwards-compatible deployments.
        if values.get("DEEP_RESEARCH_TIMEOUT_SECONDS") is not None:
            deep_default = positive_int("WORKER_JOB_TIMEOUT_SECONDS", 1200)
            return positive_int("DEEP_RESEARCH_TIMEOUT_SECONDS", deep_default)
        if values.get("WORKER_JOB_TIMEOUT_SECONDS") is not None:
            return positive_int("WORKER_JOB_TIMEOUT_SECONDS", 300)
        return 1200
    global_default = values.get("WORKER_JOB_TIMEOUT_SECONDS")
    if global_default is not None:
        return positive_int("WORKER_JOB_TIMEOUT_SECONDS", 300)
    return 300


async def run_once(
    *,
    store: JobStore,
    adapter: ResearchEngineAdapter,
    lease: JobLease,
    snapshot: JobSnapshot,
    hooks: RunnerHooks | None = None,
    draft_factory: "Callable[[JobSnapshot, tuple[AdapterSource, ...], str, dict[str, object] | None], Awaitable[str | None]] | None" = None,
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
        report_length=snapshot.report_length,
        max_urls_to_scrape=snapshot.max_urls_to_scrape,
        timeout_seconds=_resolve_worker_timeout(snapshot.report_length),
    )
    started_monotonic = asyncio.get_event_loop().time()

    def error_details(
        current_step: AiJobStep | None,
        *,
        adapter_status: AdapterStatus | None = None,
        code: str | None = None,
    ) -> dict[str, object]:
        """Build safe, structured diagnostics without prompt/source content."""
        return {
            "phase": current_step or "unknown",
            "elapsedSeconds": round(asyncio.get_event_loop().time() - started_monotonic, 2),
            "budgetSeconds": request.timeout_seconds,
            "attempt": snapshot.attempts,
            "adapter": type(adapter).__name__,
            "reportType": request.report_type,
            "sourcePolicy": request.source_policy,
            "sourceRefsCount": len(request.source_refs),
            "sourcesCount": len(adapter_status.sources) if adapter_status else 0,
            "currentStep": adapter_status.current_step if adapter_status else current_step,
            "adapterStatus": adapter_status.status if adapter_status else None,
            "adapterErrorCode": adapter_status.error_code if adapter_status else code,
        }

    # The job budget must cover every adapter boundary, not only the time
    # between successful polls. A provider can hang while submitting or
    # reading status; without a bounded await the loop below can never reach
    # its deadline and the user sees an immortal "running" task.
    deadline_monotonic = asyncio.get_event_loop().time() + request.timeout_seconds

    async def timeout_outcome(last_status: AdapterStatus | None) -> RunOutcome:
        """Persist an honest timeout even when the adapter call is stuck."""
        try:
            await asyncio.wait_for(adapter.cancel(lease.job_id), timeout=5.0)
        except (AdapterError, asyncio.TimeoutError):
            # Cancellation is best effort. The durable job state still needs
            # to leave running so the UI and reaper can recover it.
            pass

        timeout_status = last_status
        captured_output = (
            timeout_status.output_text.strip()
            if timeout_status is not None
            and timeout_status.output_text
            and timeout_status.output_text.strip()
            else None
        )
        captured_sources = timeout_status.sources if timeout_status is not None else ()
        has_partial_evidence = len(captured_sources) >= PARTIAL_MIN_SOURCES
        timeout_final_status: Literal["partial", "failed"] = (
            "partial" if captured_output and has_partial_evidence else "failed"
        )
        timeout_message = (
            "研究稿已生成，但任务在自动审核完成前达到时间上限；已保留阶段性研究稿。"
            if timeout_final_status == AI_JOB_STATUS["PARTIAL"]
            else "任务达到时间上限；已保留已抓取资料，请重新运行。"
        )
        current_step = timeout_status.current_step if timeout_status is not None else snapshot.current_step
        hooks.on_lease_lost(lease)
        await store.mark_terminal(
            lease,
            timeout_final_status,
            current_step=current_step,
            error_code="WORKER_TIMEOUT",
            error_message=timeout_message,
            error_details=error_details(
                current_step,
                adapter_status=timeout_status,
                code="WORKER_TIMEOUT",
            ),
            draft_research_id=None,
            output_text=captured_output,
        )
        return RunOutcome(
            job_id=lease.job_id,
            final_status=timeout_final_status,
            cost=timeout_status.cost if timeout_status is not None else _zero_cost(),
            sources=captured_sources,
            current_step=current_step,
            error_code="WORKER_TIMEOUT",
            error_message=timeout_message,
            error_details=error_details(
                current_step,
                adapter_status=timeout_status,
                code="WORKER_TIMEOUT",
            ),
            output_text=captured_output,
        )

    try:
        await asyncio.wait_for(
            adapter.submit(request),
            timeout=max(0.1, deadline_monotonic - asyncio.get_event_loop().time()),
        )
    except asyncio.TimeoutError:
        return await timeout_outcome(None)
    except AdapterError:
        # Adapter refused — most likely duplicate submit (idempotent on
        # job_id). We still poll get_status below.
        pass

    # Poll until terminal. Cap iterations to keep tests fast.
    terminal: AdapterStatus | None = None
    last_status: AdapterStatus | None = None
    _last_heartbeat = 0.0
    _heartbeat_seconds = max(0.01, float(lease.heartbeat_interval_seconds))
    while True:
        # 每 15s 调一次 store.heartbeat()。失去 lease 后由 reaper 负责恢复，
        # 因此 worker 不能继续写入；轮询间隔保持 0.5s（测试 0.05s）。
        now_ts = asyncio.get_event_loop().time()
        if now_ts - _last_heartbeat >= _heartbeat_seconds:
            try:
                heartbeat = await store.heartbeat(lease)
                _last_heartbeat = now_ts
            except LeaseLostError:
                heartbeat = None
            if heartbeat is None or not heartbeat.renewed:
                hooks.on_lease_lost(lease)
                return RunOutcome(
                    job_id=lease.job_id,
                    final_status="failed",
                    cost=_zero_cost(),
                    sources=(),
                    current_step=None,
                    error_code="WORKER_LEASE_LOST",
                    error_message=(
                        heartbeat.reason
                        if heartbeat is not None and heartbeat.reason
                        else "lease expired during poll"
                    ),
                    error_details=error_details(snapshot.current_step, code="WORKER_LEASE_LOST"),
                )
        try:
            status = await asyncio.wait_for(
                adapter.get_status(lease.job_id),
                timeout=max(0.1, deadline_monotonic - asyncio.get_event_loop().time()),
            )
            last_status = status
        except asyncio.TimeoutError:
            # Do not attempt another unbounded final status read here. The
            # last completed snapshot is enough to preserve inspectable
            # evidence, and timeout_outcome guarantees a terminal DB state.
            return await timeout_outcome(last_status)
        except AdapterError as exc:
            if exc.code == "AI_JOB_NOT_FOUND":
                # Adapter restarted and lost our job — treat as failed.
                await store.mark_terminal(
                    lease,
                    "failed",
                    current_step=None,
                    error_code=exc.code,
                    error_message=exc.message,
                    error_details=error_details(snapshot.current_step, code=exc.code),
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
                review_details=_review_details(status.output_metadata),
                output_text=status.output_text,
                prune_sources=status.status == AI_JOB_STATUS["SUCCEEDED"],
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
            review_details=_review_details(status.output_metadata),
            output_text=status.output_text,
        )
        if asyncio.get_event_loop().time() >= deadline_monotonic:
            return await timeout_outcome(status)
        await asyncio.sleep(0.05 if os.environ.get("AI_ENGINE_TEST_FAST_POLL") else 0.5)

    assert terminal is not None  # noqa: S101 — for mypy

    final_status: AiJobStatus = terminal.status
    draft_id: str | None = None
    output_text: str | None = None
    sources_tuple: tuple[AdapterSource, ...] = terminal.sources
    review_details = _review_details(terminal.output_metadata)
    if final_status == AI_JOB_STATUS["PARTIAL"] and terminal.output_text:
        # A partial deep run may have finished research and writing but miss
        # the publication/review boundary. Persist the readable report inline
        # so the user can inspect it and continue from evidence, without
        # falsely creating a publishable Research draft.
        output_text = terminal.output_text.strip() or None

    if final_status == AI_JOB_STATUS["SUCCEEDED"]:
            # research_report persists a private draft; summary_brief and the
            # internal evidence_search persist inline output and never invoke
            # the draft factory. A claim-scoped evidence task must not create
            # a second research asset as a side effect of looking for proof.
        try:
            if not terminal.output_text or not terminal.output_text.strip():
                raise ValueError("succeeded adapter result has no output_text")
            artifact_type: ArtifactType = "slides" if snapshot.report_type == "slides" else "markdown"
            artifact_content = render_artifact_content(
                terminal.output_text.strip(),
                artifact_type,
                snapshot.topic,
            )
            if snapshot.report_type in {"summary_brief", "evidence_search"}:
                output_text = artifact_content
            elif draft_factory is None:
                from ai_engine.job_runner.db_store import _drafts_for_tests
                import uuid as _uuid
                draft_id = str(_uuid.uuid4())
                _drafts_for_tests[draft_id] = {
                    "topic": snapshot.topic,
                    "requester_id": snapshot.requester_id,
                    "sources": len(sources_tuple),
                    "via": "default_factory",
                }
            else:
                draft_id = await draft_factory(
                    snapshot, sources_tuple, artifact_content, review_details
                )
                if not draft_id:
                    raise ValueError(
                        "run_once: draft_factory returned None for succeeded job; "
                        "must INSERT a research row and return its id."
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # The adapter has already produced a report, but persistence of the
            # user-facing artifact failed. Never leave the queue row in
            # ``running``: a terminal failure is honest and retryable, whereas
            # a permanently spinning progress page is neither.
            failure_code = "RESEARCH_DRAFT_PERSIST_FAILED"
            failure_message = "研究报告已生成，但保存研究稿失败，请重新运行。"
            failure_details = error_details(
                terminal.current_step,
                adapter_status=terminal,
                code=failure_code,
            )
            failure_details["failureType"] = type(exc).__name__
            await store.mark_terminal(
                lease,
                "failed",
                current_step=terminal.current_step,
                error_code=failure_code,
                error_message=failure_message,
                draft_research_id=None,
                error_details=failure_details,
                review_details=review_details,
            )
            hooks.on_terminal(
                lease,
                "failed",
                cost=terminal.cost,
                error_code=failure_code,
                error_message=failure_message,
            )
            return RunOutcome(
                job_id=lease.job_id,
                final_status="failed",
                cost=terminal.cost,
                sources=sources_tuple,
                current_step=terminal.current_step,
                error_code=failure_code,
                error_message=failure_message,
                error_details=failure_details,
                review_details=review_details,
            )

    terminal_error_details = (
        error_details(terminal.current_step, adapter_status=terminal, code=terminal.error_code)
        if terminal.status in (AI_JOB_STATUS["FAILED"], AI_JOB_STATUS["PARTIAL"])
        else None
    )
    await store.mark_terminal(
        lease,
        cast_status(final_status),  # type: ignore[arg-type]
        current_step=terminal.current_step,
        error_code=terminal.error_code,
        error_message=terminal.error_message,
        draft_research_id=draft_id,
        output_text=output_text,
        error_details=terminal_error_details,
        review_details=review_details,
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
        output_text=output_text,
        error_details=terminal_error_details,
        review_details=review_details,
        field_metadata={
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "search_count": str(terminal.cost.search_count),
            # W7 (工程师 B): surface the inferred flag from the adapter's
            # structured output so the BFF can render no-source conclusions
            # differently.
            "is_inferred": "true" if (
                terminal.output_metadata
                and bool(terminal.output_metadata.get("is_inferred"))
            ) else "false",
            "fact_checks": str(
                _metadata_int(terminal.output_metadata, "fact_checks")
            ),
            "fact_corrections": str(
                _metadata_int(terminal.output_metadata, "fact_corrections")
            ),
            "fact_checks_unavailable": str(
                _metadata_int(terminal.output_metadata, "fact_checks_unavailable")
            ),
            "review_status": str(review_details.get("status", "unavailable")) if review_details else "unavailable",
            "review_attempts": str(review_details.get("attempts", 0)) if review_details else "0",
        },
    )


async def run_one_available_job(
    *,
    store: JobStore,
    adapter: ResearchEngineAdapter,
    worker_id: str | None = None,
    hooks: RunnerHooks | None = None,
    draft_factory: Callable[[JobSnapshot, tuple[AdapterSource, ...], str, dict[str, object] | None], Awaitable[str | None]] | None = None,
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
    try:
        return await run_once(
            store=store, adapter=adapter, lease=lease, snapshot=snapshot,
            hooks=hooks, draft_factory=draft_factory,
        )
    except asyncio.CancelledError:
        raise
    except LeaseLostError:
        # The lease owner changed; the reaper is responsible for recovery.
        raise
    except Exception as exc:
        # A worker exception before the normal terminal write must not strand
        # an acquired row in ``running``. Keep the user-facing error generic;
        # the exception type is enough for structured diagnostics and logs
        # retain the traceback at the worker boundary.
        failure_code = "WORKER_UNHANDLED"
        failure_message = "研究任务遇到未预期错误，请重新运行。"
        failure_details: dict[str, object] = {
            "phase": snapshot.current_step or "unknown",
            "attempt": snapshot.attempts,
            "adapter": type(adapter).__name__,
            "errorType": type(exc).__name__,
        }
        await store.mark_terminal(
            lease,
            "failed",
            current_step=snapshot.current_step,
            error_code=failure_code,
            error_message=failure_message,
            draft_research_id=None,
            error_details=failure_details,
        )
        return RunOutcome(
            job_id=lease.job_id,
            final_status="failed",
            cost=_zero_cost(),
            sources=(),
            current_step=snapshot.current_step,
            error_code=failure_code,
            error_message=failure_message,
            error_details=failure_details,
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
