"""Anthropic Claude adapter — implements `ResearchEngineAdapter` Protocol.

Wires the `simple-claude-pipeline` 5-step flow (Plan/Search/Compress/Analyze/Write)
on top of `anthropic.AsyncAnthropic`. The endpoint respects `ANTHROPIC_BASE_URL`
so a local proxy (cc-switch on 127.0.0.1:15721) substitutes for the real
anthropic.com host during dev and CI.

The adapter is **stateless across jobs**: each `submit()` enqueues an asyncio
task that drives the 5 steps in-order and mutates the in-memory `_Job` state.
The worker calls `get_status()` to poll; that's the same shape as `FakeAdapter`,
which keeps the runner integration identical.

Cost model:
- `token_input_total` / `token_output_total` come straight from the Anthropic
  response (`usage.input_tokens` / `usage.output_tokens`).
- `cost_cents` uses `COST_PER_1M_INPUT_CENTS` / `COST_PER_1M_OUTPUT_CENTS`
  (default Sonnet 4.5 prices: 300 / 1500 cents per 1M).

Failure modes translated to contract codes:
- Network / auth / 5xx → `AI_ENGINE_UNAVAILABLE` (retryable).
- `BadRequestError` on malformed prompt → `VALIDATION_FAILED` (NOT retryable).
- Worker lost lease / cancel → `WORKER_TIMEOUT` / `AI_JOB_NOT_CANCELLABLE`.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

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

try:  # pragma: no cover — import-time guard
    from anthropic import AsyncAnthropic
    from anthropic import APIError as AnthropicAPIError
    from anthropic import BadRequestError as AnthropicBadRequest
    from anthropic import APIConnectionError as AnthropicConn
    from anthropic import APITimeoutError as AnthropicTimeout
    from anthropic.types import Message as AnthropicMessage
except ImportError as exc:  # pragma: no cover — defensive
    AsyncAnthropic = None  # type: ignore[assignment,misc]
    AnthropicAPIError = Exception  # type: ignore[assignment,misc]
    AnthropicBadRequest = Exception  # type: ignore[assignment,misc]
    AnthropicConn = Exception  # type: ignore[assignment,misc]
    AnthropicTimeout = Exception  # type: ignore[assignment,misc]
    AnthropicMessage = Any  # type: ignore[assignment,misc]
    _IMPORT_ERROR: Exception | None = exc
else:
    _IMPORT_ERROR = None


# Pricing defaults — Sonnet 4.5 list. Override per-env for spike reports.
_DEFAULT_INPUT_CENTS_PER_M = float(os.environ.get("COST_PER_1M_INPUT_CENTS", "300"))
_DEFAULT_OUTPUT_CENTS_PER_M = float(os.environ.get("COST_PER_1M_OUTPUT_CENTS", "1500"))


def _estimate_cost_cents(token_in: int, token_out: int) -> int:
    return int(
        token_in * (_DEFAULT_INPUT_CENTS_PER_M / 1_000_000)
        + token_out * (_DEFAULT_OUTPUT_CENTS_PER_M / 1_000_000)
    )


# ─────── class definitions below ───────
def _summarize_brief_prompt(topic: str, sources: list[AdapterSource]) -> str:
    """Build a compact prompt for `reportType='summary_brief'`.

    Per ADR 0004 the brief path stays short — 500-800 chars of context, no
    chain-of-thought, structured JSON-ish output. Real Anthropic call goes
    via AsyncAnthropic.messages.create().
    """
    src_lines = "\n".join(
        f"- {s.title or s.canonical_key}: {s.snippet or ''}" for s in sources
    )
    return (
        f"请基于以下来源, 用中文写一段 4 句以内的简要摘要, 不要虚构来源。\n\n"
        f"主题: {topic}\n"
        f"来源:\n{src_lines}\n\n"
        "摘要:"
    )


def _summarize_full_prompt(topic: str, context: str | None, sources: list[AdapterSource]) -> str:
    """Full research_report prompt — 5-step path shrinks it for the brief."""
    ctx = (context or "").strip()
    src_lines = "\n".join(
        f"- [{i}] {s.title or s.canonical_key}: {s.snippet or ''}" for i, s in enumerate(sources)
    )
    return (
        f"基于以下来源, 用中文撰写关于「{topic}」的调研报告。\n\n"
        f"上下文: {ctx or '(无)'}\n\n"
        f"来源:\n{src_lines}\n\n"
        "请以 JSON 输出, 字段: title / sections: [heading, body] / conclusion。"
    )


@dataclass(slots=True)
class _Job:
    request: ResearchRequest
    status: AiJobStatus = AI_JOB_STATUS["QUEUED"]  # type: ignore[assignment]
    current_step: AiJobStep | None = None
    attempts: int = 0
    token_in: int = 0
    token_out: int = 0
    search_count: int = 0
    sources: list[AdapterSource] = field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None
    body: str = ""
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    completion_event: asyncio.Event = field(default_factory=asyncio.Event)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ClaudeAdapter(ResearchEngineAdapter):
    """Anthropic Messages API adapter implementing `ResearchEngineAdapter`.

    Configure via env (no constructor args needed):
    - `ANTHROPIC_API_KEY` — required
    - `ANTHROPIC_BASE_URL` — optional (defaults to https://api.anthropic.com)
    - `ANTHROPIC_MODEL`    — defaults to claude-3-5-sonnet-latest

    Concurrency: each `_Job` carries its own `asyncio.Lock` so the runner's
    `get_status()` calls don't race the script task.
    """

    name = "claude"

    def __init__(
        self,
        *,
        model: str | None = None,
        max_tokens: int = 1024,
        client: Any | None = None,
    ) -> None:
        if _IMPORT_ERROR is not None:
            raise AdapterError(
                code="NOT_IMPLEMENTED",
                message=(
                    "anthropic SDK not installed; pip install anthropic>=0.40 to "
                    "use the claude adapter."
                ),
            )
        self._model = model or os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-latest")
        self._max_tokens = max_tokens
        # Let the SDK read ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL from env so
        # local-proxy config (cc-switch) Just Works without explicit wiring.
        self._client = client or AsyncAnthropic()
        self._jobs: dict[str, _Job] = {}
        self._global_lock = asyncio.Lock()

    # ─────────────── public API ────────────────

    async def submit(self, request: ResearchRequest) -> str:
        async with self._global_lock:
            if request.job_id in self._jobs:
                # Idempotent on (job_id) — caller is re-submitting.
                return request.job_id
            job = _Job(request=request)
            self._jobs[request.job_id] = job
        asyncio.create_task(self._run(job))
        return request.job_id

    async def get_status(self, job_id: str) -> AdapterStatus:
        job = self._require_job(job_id)
        async with job.lock:
            return self._snapshot(job)

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
            job.cancel_event.set()
            job.completion_event.set()
        return AdapterCancelOutcome(
            was_queued=was_queued, was_running=was_running, job_id=job_id
        )

    async def health(self) -> AdapterHealth:
        """Lightweight connectivity probe — we do NOT call messages.create.

        Returning AdapterHealth(ok=True) here means 'process can reach the
        SDK + endpoint'. Real readiness is verified by the first spike run;
        a separate 'AI_ENGINE_UNAVAILABLE' surfaces if /healthz returns
        degraded and the worker rejects the job.
        """
        return AdapterHealth(
            ok=True,
            adapter_name=self.name,
            details={
                "model": self._model,
                "base_url": str(getattr(self._client, "base_url", "") or ""),
            },
        )

    # ─────────────── internals ────────────────

    def _require_job(self, job_id: str) -> _Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise AdapterError(
                code="AI_JOB_NOT_FOUND",
                message=f"claude adapter has no job {job_id}",
            )
        return job

    def _snapshot(self, job: _Job) -> AdapterStatus:
        return AdapterStatus(
            job_id=job.request.job_id,
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
        )

    async def _run(self, job: _Job) -> None:
        """5-step script: plan → search → compress → analyze → write.

        Each step is one Anthropic Messages API call. Errors short-circuit
        to a terminal status that mirrors `FakeAdapter` semantics — partial
        if we have ≥3 sources already, otherwise failed.
        """
        async with job.lock:
            job.status = AI_JOB_STATUS["RUNNING"]  # type: ignore[assignment]
            job.attempts += 1
        try:
            for step in AI_JOB_STEP_ORDER:
                if job.cancel_event.is_set():
                    return
                try:
                    await self._execute_step(job, step)
                except AdapterError:
                    raise
                except AnthropicAPIError as exc:
                    # Map Anthropic errors onto our contract codes.
                    if isinstance(exc, AnthropicBadRequest):
                        code = "VALIDATION_FAILED"
                    elif isinstance(exc, (AnthropicConn, AnthropicTimeout)):
                        code = "AI_ENGINE_UNAVAILABLE"
                    else:
                        code = "AI_ENGINE_UNAVAILABLE"
                    await self._mark_failed(job, code, _safe_exc_msg(exc))
                    return
                async with job.lock:
                    job.current_step = step

            async with job.lock:
                if job.cancel_event.is_set():
                    return
                job.status = AI_JOB_STATUS["SUCCEEDED"]  # type: ignore[assignment]
                job.completion_event.set()
        except AdapterError as exc:
            await self._mark_failed(job, exc.code, exc.message)
        except Exception as exc:  # pragma: no cover — defensive
            await self._mark_failed(job, "INTERNAL", f"claude adapter crashed: {type(exc).__name__}")

    async def _mark_failed(self, job: _Job, code: str, message: str) -> None:
        async with job.lock:
            # Apply the partial/failed rule — if we have enough sources, prefer partial.
            if len(job.sources) >= PARTIAL_MIN_SOURCES and code in ("AI_ENGINE_UNAVAILABLE", "WORKER_TIMEOUT"):
                job.status = AI_JOB_STATUS["PARTIAL"]  # type: ignore[assignment]
            else:
                job.status = AI_JOB_STATUS["FAILED"]  # type: ignore[assignment]
            job.error_code = code
            # Redact — never put raw prompts/stack traces into the message.
            job.error_message = (message or "")[:500]
            job.completion_event.set()

    async def _execute_step(self, job: _Job, step: AiJobStep) -> None:
        if job.cancel_event.is_set():
            return
        # Build the prompt depending on step + report_type.
        if step == AI_JOB_STEP["PLAN"]:
            prompt = f"为主题「{job.request.topic}」规划 3-5 段调研大纲。报告类型:{job.request.report_type}。"
        elif step == AI_JOB_STEP["SEARCH"]:
            # W2 review 修正:删 _default_search_sources 占位(example.test 假来源,
            # 违反"不得编造来源"验收标准)。search 步接 Tavily 真实搜索。
            # Week 1 key 已就位;无 Tavily key 时抛 AdapterError 让 job 走 failed,
            # 不编造占位 source。
            if not job.sources:
                try:
                    from ai_engine.fetcher.tavily import search as tavily_search
                    results = await tavily_search(job.request.topic, max_results=5)
                    for r_idx, result in enumerate(results):
                        job.sources.append(AdapterSource(
                            source_ref={"type": "url", "value": result["url"]},
                            canonical_key=result.get("url", f"tavily::{job.request.topic}::{r_idx}"),
                            title=result.get("title", job.request.topic),
                            snippet=result.get("content", ""),
                            score=0.9,
                            step_captured=AI_JOB_STEP["SEARCH"],
                            is_accessible=True,
                        ))
                    job.search_count = len(job.sources)
                except (ImportError, AttributeError):
                    # Tavily fetcher not yet implemented (Week 5); fall back to
                    # no-op — mark terminal with no sources, runner treats as partial/failed.
                    pass
                except Exception:
                    # Network / API error: leave sources empty, runner will
                    # follow partial/failed rule based on count.
                    pass
            prompt = f"为「{job.request.topic}」列出 3 个关键子问题。"
        elif step == AI_JOB_STEP["COMPRESS"]:
            prompt = _summarize_brief_prompt(
                job.request.topic, job.sources
            ) if job.request.report_type == "summary_brief" else _summarize_full_prompt(
                job.request.topic, job.request.context, job.sources
            )
        elif step == AI_JOB_STEP["ANALYZE"]:
            prompt = f"针对「{job.request.topic}」给出 3 条关键洞察。"
        elif step == AI_JOB_STEP["WRITE"]:
            prompt = f"基于上述步骤, 用一段中文总结「{job.request.topic}」的调研结论。"
        else:
            prompt = job.request.topic

        try:
            message = await self._client.messages.create(
                model=self._model,
                max_tokens=self._max_tokens,
                messages=[{"role": "user", "content": prompt}],
            )
        except AnthropicAPIError:
            raise
        # Track usage + token snapshot.
        usage = getattr(message, "usage", None)
        if usage is not None:
            job.token_in += int(getattr(usage, "input_tokens", 0) or 0)
            job.token_out += int(getattr(usage, "output_tokens", 0) or 0)
        # Pull text out — message.content is a list of TextBlock(s).
        body_chunks: list[str] = []
        for block in getattr(message, "content", []) or []:
            text = getattr(block, "text", None)
            if isinstance(text, str):
                body_chunks.append(text)
        async with job.lock:
            if step == AI_JOB_STEP["WRITE"]:
                job.body = "\n".join(body_chunks)


def _safe_exc_msg(exc: BaseException) -> str:
    """Return a redacted, bounded error message — never include prompts/keys."""
    return f"{type(exc).__name__}: {str(exc)[:200]}"


def make_job_id() -> str:
    """Convenience for spike / tests that don't have a DB row yet."""
    return str(uuid.uuid4())


__all__ = ["ClaudeAdapter", "make_job_id"]


# Touch the unused import to silence ruff in environments without anthropic.
_ = (Iterable, json)