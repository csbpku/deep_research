"""Fake adapter — deterministic in-memory engine.

Why fake matters:
- Local dev and CI run with zero API keys.
- Tests can simulate every state-machine edge case deterministically.
- spike harness needs `fake` to run end-to-end without network or LLM cost.

Behaviour knobs:
- `mode` selects the default outcome script for a fresh job.
- `scripts` lets tests pre-program a per-job script (success/partial/fail/
  timeout/cancel).
- `clock` and `sleep` allow tests to fast-forward without `asyncio.sleep`.

The fake never touches the network and never stores anything in a DB; the
Week 5 worker is what eventually writes back to `ai_research_jobs`. The
fake just exposes the contract surface that the worker relies on.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal, cast

from ai_engine.adapters.base import (
    AdapterCancelOutcome,
    AdapterHealth,
    AdapterSource,
    AdapterStatus,
    CostMetrics,
    ResearchEngineAdapter,
    ResearchRequest,
)
from ai_engine.contracts.errors import AdapterError
from ai_engine.contracts.states import (
    AI_JOB_STATUS,
    AI_JOB_STEP,
    AI_JOB_STEP_ORDER,
    PARTIAL_MIN_SOURCES,
    AiJobStep,
    AiJobStatus,
)

FakeMode = Literal["success", "partial", "failed", "timeout"]


@dataclass(slots=True)
class _Job:
    request: ResearchRequest
    mode: FakeMode
    sources: list[AdapterSource] = field(default_factory=list)
    token_in: int = 0
    token_out: int = 0
    search_count: int = 0
    status: AiJobStatus = AI_JOB_STATUS["QUEUED"]  # type: ignore[assignment]
    current_step: AiJobStep | None = None
    attempts: int = 0
    error_code: str | None = None
    error_message: str | None = None
    body: str = ""
    # W7 (工程师 B): mark output as inferred when no source was
    # captured (mirrors GptResearcherAdapter.inferred for the contract).
    inferred: bool = False
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    completion_event: asyncio.Event = field(default_factory=asyncio.Event)


def _default_topic_sources(topic: str, count: int) -> list[AdapterSource]:
    """Build deterministic placeholder sources for a topic.

    Each source carries a plausible title (derived from topic), a stable
    canonical_key, and a snippet. The `is_accessible` flag is set False on
    `count`th source for `partial`/`failed` modes to test the
    ≥ PARTIAL_MIN_SOURCES rule.
    """
    out: list[AdapterSource] = []
    for i in range(count):
        out.append(
            AdapterSource(
                source_ref={"type": "url", "value": f"https://example.test/{topic}/{i}"},
                canonical_key=f"example.test::{topic}::{i}",
                title=f"Placeholder source {i + 1} for {topic}",
                snippet=f"Snippet {i + 1} for topic {topic}.",
                score=0.9 - 0.05 * i,
                step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
                is_accessible=True,
            )
        )
    return out


class FakeAdapter(ResearchEngineAdapter):
    """In-memory adapter; safe in tests and for local spike runs.

    Concurrency: each `_Job` carries its own `asyncio.Lock` so two concurrent
    `get_status`/`cancel` calls on the same job do not race the script
    runner.
    """

    name = "fake"

    def __init__(
        self,
        *,
        default_mode: FakeMode = "success",
        step_seconds: float = 0.0,
        sources_per_job: int = 5,
    ) -> None:
        # step_seconds default 0 keeps tests fast; set >0 manually to
        # exercise cancel during a step.
        if step_seconds < 0:
            raise ValueError("step_seconds must be >= 0")
        self._default_mode = default_mode
        self._step_seconds = step_seconds
        self._sources_per_job = sources_per_job
        self._jobs: dict[str, _Job] = {}
        self._global_lock = asyncio.Lock()

    # ───────────────────────── public API ──────────────────────────

    async def submit(self, request: ResearchRequest) -> str:
        async with self._global_lock:
            if request.job_id in self._jobs:
                # Idempotent on (job_id) — return existing handle.
                return request.job_id
            job = _Job(request=request, mode=self._default_mode)
            for index, source_ref in enumerate(request.source_refs):
                value = source_ref.get("value")
                if source_ref.get("type") == "url" and isinstance(value, str):
                    job.sources.append(
                        AdapterSource(
                            source_ref=source_ref,
                            canonical_key=value,
                            title=request.topic,
                            snippet=request.context,
                            score=1.0,
                            step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
                            is_accessible=True,
                        )
                    )
            self._jobs[request.job_id] = job
        # Kick off execution in the background. The fake does not block the
        # submitter — this mirrors how a real engine would return a queue
        # handle immediately.
        asyncio.create_task(self._run(job))
        return request.job_id

    async def get_status(self, job_id: str) -> AdapterStatus:
        job = self._require_job(job_id)
        async with job.lock:
            return AdapterStatus(
                job_id=job_id,
                status=job.status,
                current_step=job.current_step,
                attempts=job.attempts,
                sources=tuple(job.sources),
                cost=CostMetrics(
                    token_input_total=job.token_in,
                    token_output_total=job.token_out,
                    cost_cents=_estimate_cost_cents(job.token_in, job.token_out),
                    search_count=job.search_count,
                ),
                error_code=job.error_code,
                error_message=job.error_message,
                output_text=job.body or None,
                output_metadata={"is_inferred": job.inferred} if job.inferred else None,
            )

    async def cancel(self, job_id: str) -> AdapterCancelOutcome:
        job = self._require_job(job_id)
        async with job.lock:
            if job.status in (
                AI_JOB_STATUS["SUCCEEDED"],
                AI_JOB_STATUS["FAILED"],
                AI_JOB_STATUS["PARTIAL"],
                AI_JOB_STATUS["CANCELLED"],
            ):
                raise AdapterError(
                    code="AI_JOB_NOT_CANCELLABLE",
                    message=f"job {job_id} is in terminal state {job.status}",
                )
            was_queued = job.status == AI_JOB_STATUS["QUEUED"]
            was_running = job.status == AI_JOB_STATUS["RUNNING"]
            job.status = AI_JOB_STATUS["CANCELLED"]  # type: ignore[assignment]
            job.error_code = None
            job.error_message = None
            job.cancel_event.set()
            job.completion_event.set()
        return AdapterCancelOutcome(
            was_queued=was_queued,
            was_running=was_running,
            job_id=job_id,
        )

    async def health(self) -> AdapterHealth:
        return AdapterHealth(
            ok=True,
            adapter_name=self.name,
            details={"jobs_in_memory": str(len(self._jobs))},
        )

    # ───────────────────────── test helpers ────────────────────────

    def configure(self, job_id: str, *, mode: FakeMode) -> None:
        """Override the script for an existing job. Used in tests."""
        job = self._require_job(job_id)
        job.mode = mode

    def seed_sources(self, job_id: str, sources: Iterable[AdapterSource]) -> None:
        """Pre-populate sources (e.g. simulate already-captured user refs)."""
        job = self._require_job(job_id)
        job.sources.extend(sources)

    async def wait_completion(self, job_id: str, timeout: float = 5.0) -> AdapterStatus:
        """Block until the script finishes. Tests-only convenience."""
        job = self._require_job(job_id)
        try:
            await asyncio.wait_for(job.completion_event.wait(), timeout=timeout)
        except TimeoutError:
            raise AdapterError(
                code="WORKER_TIMEOUT",
                message=f"fake adapter did not finish job {job_id} in {timeout}s",
            ) from None
        return await self.get_status(job_id)

    # ───────────────────────── internals ────────────────────────────

    def _require_job(self, job_id: str) -> _Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise AdapterError(
                code="AI_JOB_NOT_FOUND",
                message=f"fake adapter has no job {job_id}",
            )
        return job

    async def _run(self, job: _Job) -> None:
        async with job.lock:
            job.status = AI_JOB_STATUS["RUNNING"]  # type: ignore[assignment]
            job.attempts += 1
        try:
            if job.mode == "timeout":
                # Never completes by itself; surfaces as a worker timeout.
                await job.cancel_event.wait()
                return

            steps = (
                (AI_JOB_STEP["SEARCH"], AI_JOB_STEP["COMPRESS"], AI_JOB_STEP["WRITE"])
                if job.request.report_type == "summary_brief"
                else AI_JOB_STEP_ORDER
            )
            for step in cast(tuple[AiJobStep, ...], steps):
                if job.cancel_event.is_set():
                    return
                await self._execute_step(job, step)
                async with job.lock:
                    job.current_step = step

            # W7 (工程师 B): if no source made it through, mark the
            # output as inferred so the BFF can render it accordingly.
            async with job.lock:
                if not job.sources:
                    job.inferred = True

            # Final outcome.
            async with job.lock:
                if job.cancel_event.is_set():
                    return
                job.status = AI_JOB_STATUS["SUCCEEDED"]  # type: ignore[assignment]
                job.completion_event.set()
        except _ScriptAbort:
            # Script-level abort — terminal status already written inside
            # `_execute_step`. Just propagate so the background task ends.
            return
        except Exception as exc:  # pragma: no cover — defensive
            async with job.lock:
                job.status = AI_JOB_STATUS["FAILED"]  # type: ignore[assignment]
                job.error_code = "INTERNAL"
                job.error_message = "fake adapter crashed"
            job.completion_event.set()
            raise exc

    async def _execute_step(self, job: _Job, step: AiJobStep) -> None:
        # Simulate work without leaking prompt content into logs.
        if self._step_seconds > 0:
            try:
                await asyncio.wait_for(job.cancel_event.wait(), timeout=self._step_seconds)
                return
            except TimeoutError:
                pass
        async with job.lock:
            if step == AI_JOB_STEP["PLAN"]:
                job.token_in += 200
                job.token_out += 80
            elif step == AI_JOB_STEP["SEARCH"]:
                # Generate placeholder sources if none yet seeded.
                if not job.sources:
                    for src in _default_topic_sources(
                        job.request.topic, self._sources_per_job
                    ):
                        job.sources.append(src)
                job.search_count += len(job.sources)
                job.token_in += len(job.sources) * 100
                job.token_out += 50
                if job.mode == "failed":
                    if len(job.sources) < PARTIAL_MIN_SOURCES:
                        # Insufficient sources → terminal FAILED.
                        job.status = cast(AiJobStatus, AI_JOB_STATUS["FAILED"])
                        job.error_code = "AI_ENGINE_UNAVAILABLE"
                        job.error_message = "fake: simulated search failure"
                        job.completion_event.set()
                        raise _ScriptAbort("failed_search")
                    # Else: too many sources to qualify as failed; fall
                    # through and let `failed` abort later.
            elif step == AI_JOB_STEP["COMPRESS"]:
                job.token_in += 300
                job.token_out += 120
                if job.mode == "partial":
                    # Force a downstream 5xx — simulate partial completion
                    # with >= PARTIAL_MIN_SOURCES already captured.
                    if len(job.sources) >= PARTIAL_MIN_SOURCES:
                        job.status = cast(AiJobStatus, AI_JOB_STATUS["PARTIAL"])
                        job.error_code = "WORKER_TIMEOUT"
                        job.error_message = "fake: simulated compress timeout"
                        job.completion_event.set()
                        raise _ScriptAbort("partial_compress")
                elif job.mode == "failed":
                    # We already have enough sources to qualify for partial;
                    # explicit `failed` script aborts here as FAILED.
                    job.status = cast(AiJobStatus, AI_JOB_STATUS["FAILED"])
                    job.error_code = "AI_ENGINE_UNAVAILABLE"
                    job.error_message = "fake: simulated compress failure"
                    job.completion_event.set()
                    raise _ScriptAbort("failed_compress")
            elif step == AI_JOB_STEP["ANALYZE"]:
                job.token_in += 400
                job.token_out += 160
            elif step == AI_JOB_STEP["WRITE"]:
                job.body = f"{job.request.topic}\n\n基于已验证来源生成的简要摘要。"
                job.token_in += 500
                job.token_out += 800


class _ScriptAbort(Exception):
    """Internal signal — fake adapter uses this to short-circuit a script."""


def _estimate_cost_cents(token_in: int, token_out: int) -> int:
    """Rough cost estimate — uses Claude Sonnet 4.5 list price as default.

    Override per env (COST_PER_1M_INPUT_CENTS / COST_PER_1M_OUTPUT_CENTS)
    so spike reports can switch to gpt-researcher pricing without code.

    Default: $3 / 1M input, $15 / 1M output → 0.3 cents / 1k in,
    1.5 cents / 1k out. Returns integer cents.
    """
    in_rate = float(os.environ.get("COST_PER_1M_INPUT_CENTS", "300")) / 1_000_000
    out_rate = float(os.environ.get("COST_PER_1M_OUTPUT_CENTS", "1500")) / 1_000_000
    return int(token_in * in_rate + token_out * out_rate)


def make_job_id() -> str:
    """Convenience for tests/spike that don't have a DB row yet."""
    return str(uuid.uuid4())


__all__ = [
    "FakeAdapter",
    "FakeMode",
    "make_job_id",
]
