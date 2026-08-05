"""GPT Researcher adapter — implements `ResearchEngineAdapter` Protocol.

Wraps the `gpt-researcher` library (v0.15.x) as the primary research
engine.  gpt-researcher uses a planner-executor-publisher pattern with
parallelized sub-query research, web scraping, and LLM-based report
generation.

The adapter is **stateless across jobs**: each ``submit()`` enqueues an
asyncio task that drives ``GPTResearcher.conduct_research()`` +
``write_report()`` and mutates the in-memory ``_Job`` state.  The worker
calls ``get_status()`` to poll — same shape as ``FakeAdapter``.

Compatibility patches
----------------------
gpt-researcher 0.15.x has three bugs when used with non-OpenAI LLM
providers (e.g. Anthropic via LangChain):

1. ``ChatAnthropic`` returns ``AIMessage.content`` as a *list* of
   content blocks, but gpt-researcher assumes *str* everywhere.
2. ``estimate_llm_cost`` calls ``tiktoken.encode()`` on the response,
   which crashes on non-string input.
3. ``OpenAIEmbeddings`` hits ``/v1/embeddings`` which the local proxy
   does not serve (404).

Patches 1 and 2 are applied at import time via monkey-patching
``GenericLLMProvider.get_chat_response`` and
``estimate_llm_cost``.  Patch 3 is handled by setting
``COMPRESSION_THRESHOLD`` so the context compressor always uses the
fast path (no embedding calls).
"""

from __future__ import annotations

import asyncio
import os
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, cast

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
    PARTIAL_MIN_SOURCES,
    AiJobStep,
    AiJobStatus,
)

# ── Import gpt-researcher with compatibility patches ──────────────

try:  # pragma: no cover — import-time guard
    # Patch estimate_llm_cost BEFORE importing gpt_researcher modules that
    # capture it by name.
    import gpt_researcher.utils.costs as _costs_mod  # type: ignore[import-untyped]
    import gpt_researcher.utils.llm as _llm_mod  # type: ignore[import-untyped]

    _original_estimate = _costs_mod.estimate_llm_cost

    def _to_str(val: Any) -> str:
        """Flatten LangChain AIMessage.content (list of blocks) to str."""
        if val is None:
            return ""
        if isinstance(val, str):
            return val
        if isinstance(val, list):
            parts: list[str] = []
            for item in val:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict):
                    if item.get("type") == "text":
                        parts.append(str(item.get("text", "")))
                    elif item.get("type") is None and "content" in item:
                        parts.append(str(item.get("content", "")))
                else:
                    parts.append(str(getattr(item, "text", str(item))))
            return "".join(parts)
        return str(getattr(val, "content", val))

    def _safe_estimate(input_content: Any, output_content: Any) -> float:
        try:
            return float(_original_estimate(_to_str(input_content), _to_str(output_content)))
        except Exception:
            return 0.0

    _costs_mod.estimate_llm_cost = _safe_estimate
    _llm_mod.estimate_llm_cost = _safe_estimate

    # Patch Memory.__init__ so it doesn't require OPENAI_API_KEY.
    # gpt-researcher's Memory hardcodes the OpenAI embeddings provider,
    # which crashes when no OPENAI_API_KEY is set (we use the compass
    # gateway via ANTHROPIC_*_HEAVY). We force the 'custom' provider
    # and inject the heavy key as the embedding key. If embeddings are
    # actually called (e.g. context compression), they fail downstream
    # rather than crashing on init; with COMPRESSION_THRESHOLD=999999
    # the embeddings path is bypassed entirely so this is harmless.
    import gpt_researcher.memory.embeddings as _mem_mod  # type: ignore[import-untyped]

    def _patched_memory_init(
        self: Any,
        embedding_provider: str,
        model: str,
        **embedding_kwargs: Any,
    ) -> None:
        heavy_key = (
            os.environ.get("OPENAI_API_KEY_HEAVY")
            or os.environ.get("OPENAI_API_KEY")
            or os.environ.get("ANTHROPIC_API_KEY_HEAVY")
            or os.environ.get("ANTHROPIC_API_KEY", "")
        )
        heavy_base_url = (
            os.environ.get("OPENAI_BASE_URL_HEAVY")
            or os.environ.get("OPENAI_BASE_URL")
            or os.environ.get("ANTHROPIC_BASE_URL_HEAVY")
            or os.environ.get("ANTHROPIC_BASE_URL")
            or "http://localhost:1234/v1"
        )
        from langchain_openai import OpenAIEmbeddings
        from pydantic import SecretStr
        self._embeddings = OpenAIEmbeddings(
            model=model,
            api_key=SecretStr(heavy_key or "custom"),
            base_url=heavy_base_url,
            check_embedding_ctx_length=False,
            **embedding_kwargs,
        )

    _mem_mod.Memory.__init__ = _patched_memory_init

    # Patch GenericLLMProvider.get_chat_response to flatten content blocks.
    from gpt_researcher.llm_provider.generic.base import GenericLLMProvider  # type: ignore[import-untyped]

    async def _patched_get_chat(
        self: GenericLLMProvider,
        messages: list[Any],
        stream: bool,
        websocket: Any | None = None,
        **kwargs: Any,
    ) -> str:
        if not stream:
            output = await self.llm.ainvoke(messages, **kwargs)
            res = _to_str(output.content)
        else:
            paragraph = ""
            res = ""
            async for chunk in self.llm.astream(messages, **kwargs):
                content = _to_str(chunk.content)
                if not content:
                    continue
                res += content
                paragraph += content
                if "\n" in paragraph:
                    if websocket:
                        await self._send_output(paragraph, websocket)
                    paragraph = ""
            if paragraph and websocket:
                await self._send_output(paragraph, websocket)
        if self.chat_logger:
            await self.chat_logger.log_request(messages, res)
        return res

    GenericLLMProvider.get_chat_response = _patched_get_chat

    from gpt_researcher import GPTResearcher  # noqa: E402

    _IMPORT_ERROR: Exception | None = None
except ImportError as exc:  # pragma: no cover — defensive
    GPTResearcher = None
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


# ── Step event capture via fake WebSocket ──────────────────────────

class _StepCaptureWebSocket:
    """Capture gpt-researcher ``logs`` events and map them to ``AiJobStep``.

    gpt-researcher emits WebSocket events like::

        {"type": "logs", "content": "planning_research", "output": "..."}

    We map the ``content`` field to our ``AiJobStep`` enum so
    ``get_status()`` can report progress.
    """

    _STEP_MAP: dict[str, str] = {
        "starting_research": AI_JOB_STEP["PLAN"],
        "planning_research": AI_JOB_STEP["PLAN"],
        "agent_generated": AI_JOB_STEP["PLAN"],
        "running_subquery_research": AI_JOB_STEP["SEARCH"],
        "scraping_urls": AI_JOB_STEP["SEARCH"],
        "fetching_query_content": AI_JOB_STEP["COMPRESS"],
        "research_step_finalized": AI_JOB_STEP["ANALYZE"],
        "writing_report": AI_JOB_STEP["WRITE"],
    }

    def __init__(self, job: _Job) -> None:
        self._job = job

    async def send_json(self, data: dict[str, Any]) -> None:
        evt_type = data.get("type", "")
        content = data.get("content", "")
        if evt_type == "logs" and content in self._STEP_MAP:
            step = self._STEP_MAP[content]
            async with self._job.lock:
                self._job.current_step = cast("AiJobStep", step)


def _collect_sources_from_research(
    research_sources: list[dict[str, Any]],
    visited_urls: Iterable[str],
    topic: str,
) -> list[AdapterSource]:
    """Map gpt-researcher's captured sources into :class:`AdapterSource`.

    gpt-researcher 0.15.x stores successfully scraped pages in
    ``research_sources`` (``url`` / ``title`` / ``raw_content``); the public
    ``visited_urls`` set is a fallback for versions or plugins that don't
    populate ``research_sources``.  Dedup by canonical URL.
    """
    seen: set[str] = set()
    out: list[AdapterSource] = []

    def append(url: str, title: object, snippet: str | None) -> None:
        if url in seen:
            return
        seen.add(url)
        clean_title = title if isinstance(title, str) and title.strip() else topic
        out.append(
            AdapterSource(
                source_ref={"type": "url", "value": url},
                canonical_key=url,
                title=clean_title,
                snippet=snippet,
                score=0.9,
                step_captured=cast("AiJobStep", AI_JOB_STEP["SEARCH"]),
                is_accessible=True,
            )
        )

    for item in research_sources:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url.strip():
            continue
        raw = item.get("raw_content")
        snippet = None
        if isinstance(raw, str) and raw.strip():
            snippet = " ".join(raw.split())[:240]
        append(url.strip(), item.get("title"), snippet)

    for url in visited_urls:
        if isinstance(url, str) and url.strip():
            append(url.strip(), topic, None)

    return out


_REFERENCE_HEADING_RE = re.compile(
    r"(?im)^#{1,6}\s*(?:参考文献|参考资料|参考来源|References?|Sources?)\s*[:：]?\s*$"
)

_CONTINUATION_SYSTEM = (
    "你是专业的调研报告写手。只输出续写内容，不要复述已有报告，"
    "不要添加任何解释，不要虚构来源。"
)


def _report_has_references(report: str) -> bool:
    return bool(_REFERENCE_HEADING_RE.search(report))


def _strip_reference_section(report: str) -> str:
    """Remove any trailing reference section so we can rebuild it deterministically."""
    match = _REFERENCE_HEADING_RE.search(report)
    if not match:
        return report.strip()
    return report[:match.start()].rstrip()


def _report_needs_completion(report: str, sources: list[AdapterSource]) -> bool:
    """True when the report has no reference section or ends mid-sentence."""
    if _report_has_references(report):
        return False
    if not sources:
        return False
    lines = report.strip().splitlines()
    if not lines:
        return True
    last = lines[-1].strip()
    if not last:
        return True
    if re.match(r"^#{1,6}\s+", last):
        return True
    return not bool(re.search(r"[。！？.!?）)」』\"']\s*$", last))


def _format_source_lines(sources: list[AdapterSource]) -> str:
    lines: list[str] = []
    for index, source in enumerate(sources, start=1):
        title = (source.title or source.canonical_key or "来源").strip()
        ref = source.source_ref if isinstance(source.source_ref, dict) else {}
        url = ref.get("value")
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            lines.append(f"{index}. [{title}]({url})")
        elif isinstance(url, str):
            lines.append(f"{index}. {title} ({url})")
        else:
            lines.append(f"{index}. {title}")
    return "\n".join(lines)


def _append_references(report: str, sources: list[AdapterSource]) -> str:
    if not sources:
        return report
    body = _strip_reference_section(report)
    return f"{body.rstrip()}\n\n## 参考文献\n\n{_format_source_lines(sources)}"


def _strip_overlap(previous: str, chunk: str) -> str:
    """Drop the tail sentence when the model repeated it in its continuation."""
    previous_lines = [line.strip() for line in previous.strip().splitlines() if line.strip()]
    if not previous_lines:
        return chunk
    marker = previous_lines[-1]
    cleaned = chunk.strip()
    if cleaned.startswith(marker):
        cleaned = cleaned[len(marker):].lstrip("\n ")
    return cleaned


async def _request_report_continuation(
    researcher: Any,
    report: str,
    sources: list[AdapterSource],
) -> str:
    """Ask the same smart LLM to finish a truncated report."""
    try:
        from gpt_researcher.utils.llm import create_chat_completion
    except ImportError:
        return ""
    cfg = researcher.cfg
    topic = researcher.query
    source_lines = _format_source_lines(sources)
    user_content = (
        f"以下是关于「{topic}」的调研报告。它可能因为输出长度限制在中间被截断。\n\n"
        "请从最后一个句子处继续，先补齐被截断的内容，再完成剩余章节，"
        "最后必须包含一个 `## 结论` 小节和一个 `## 参考文献` 小节。\n\n"
        "如果已有报告已经完整，并且已经包含结论和参考文献，只回复 DONE。\n\n"
        "已有报告末尾（用于衔接，不要重复）：\n"
        f"{report[-2500:]}\n\n"
        "真实来源（只能引用这些）：\n"
        f"{source_lines}\n\n"
        "请直接输出续写内容："
    )
    try:
        return _to_str(
            await create_chat_completion(
                messages=[
                    {"role": "system", "content": _CONTINUATION_SYSTEM},
                    {"role": "user", "content": user_content},
                ],
                model=cfg.smart_llm_model,
                temperature=0.35,
                max_tokens=8000,
                llm_provider=cfg.smart_llm_provider,
                stream=False,
                websocket=None,
                llm_kwargs=cfg.llm_kwargs or None,
                cost_callback=None,
            )
        )
    except Exception:
        return ""


async def _ensure_complete_report(
    researcher: Any,
    report: str,
    sources: list[AdapterSource],
    *,
    max_rounds: int = 2,
) -> str:
    """Continue a truncated report and always attach grounded references."""
    parts = [report]
    for _ in range(max_rounds):
        current = "\n\n".join(parts)
        if not _report_needs_completion(current, sources):
            break
        chunk = await _request_report_continuation(researcher, current, sources)
        if not chunk.strip():
            break
        if chunk.strip().upper() == "DONE":
            break
        chunk = _strip_overlap(current, chunk)
        if not chunk.strip():
            break
        parts.append(chunk.strip())
    current = "\n\n".join(parts)
    if sources:
        current = _append_references(current, sources)
    return current.strip()


# ── Job state ──────────────────────────────────────────────────────

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
    inferred: bool = False
    cost_usd: float = 0.0
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    completion_event: asyncio.Event = field(default_factory=asyncio.Event)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _resolved_internal_sources(
    source_refs: tuple[dict[str, str | bool], ...],
) -> list[AdapterSource]:
    sources: list[AdapterSource] = []
    for ref in source_refs:
        kind = ref.get("type")
        value = ref.get("value")
        snippet = ref.get("resolvedSnippet")
        if kind not in {"summary", "research"} or not isinstance(value, str):
            continue
        if not isinstance(snippet, str) or not snippet.strip():
            continue
        source_ref: dict[str, str | bool] = {"type": kind, "value": value}
        if isinstance(ref.get("required"), bool):
            source_ref["required"] = ref["required"]
        sources.append(
            AdapterSource(
                source_ref=source_ref,
                canonical_key=value,
                title=str(ref.get("resolvedTitle") or value),
                snippet=snippet,
                score=1.0,
                step_captured=cast("AiJobStep", AI_JOB_STEP["SEARCH"]),
                is_accessible=True,
            )
        )
    return sources


# ── Adapter ────────────────────────────────────────────────────────

class GptResearcherAdapter(ResearchEngineAdapter):
    """GPT Researcher adapter implementing ``ResearchEngineAdapter``.

    Configure via env (heavy tier = gpt-researcher pipeline):
    - ``SMART_LLM`` / ``FAST_LLM`` / ``STRATEGIC_LLM`` — format
      ``<provider>:<model>`` (e.g. ``anthropic:claude-haiku-4-5@20251001``).
    - ``ANTHROPIC_API_KEY_HEAVY`` / ``ANTHROPIC_BASE_URL_HEAVY`` —
      credential pair for the heavy tier (e.g. Shopee compass gateway).
      Falls back to ``ANTHROPIC_API_KEY`` / ``ANTHROPIC_BASE_URL`` when unset.

    Light tier (brief summaries, distilled scorer, chat follow-ups):
    - ``BRIEF_LLM`` — format ``<provider>:<model>``. Falls back to
      ``SMART_LLM`` for backward compatibility.
    - ``ANTHROPIC_API_KEY`` / ``ANTHROPIC_BASE_URL`` — light credentials.

    Other:
    - ``TAVILY_API_KEY`` — required for web search.

    The adapter reads all LLM specs and credentials at construction time
    so the model and endpoint can be swapped without code changes.
    """

    name = "gpt_researcher"

    def __init__(
        self,
        *,
        llm_spec: str | None = None,
        brief_llm: str | None = None,
    ) -> None:
        if _IMPORT_ERROR is not None:
            raise AdapterError(
                code="NOT_IMPLEMENTED",
                message=(
                    "gpt-researcher is not installed; "
                    "pip install gpt-researcher to use this adapter."
                ),
            )
        # Heavy tier — gpt-researcher pipeline (SMART/STRATEGIC slots
        # default to llm_spec; FAST slot defaults to BRIEF_LLM for cost).
        self._llm_spec = llm_spec or os.environ.get(
            "SMART_LLM", "anthropic:claude-haiku-4-5"
        )
        # Light tier — brief summaries, distilled scorer, chat.
        self._brief_llm = brief_llm or os.environ.get(
            "BRIEF_LLM", self._llm_spec
        )
        # Per-slot models for gpt-researcher; FAST defaults to brief
        # (cheap, fast subqueries) unless explicitly overridden.
        self._fast_llm = os.environ.get("FAST_LLM", self._brief_llm)
        self._strategic_llm = os.environ.get(
            "STRATEGIC_LLM", self._llm_spec
        )
        self._jobs: dict[str, _Job] = {}
        self._global_lock = asyncio.Lock()

    # ─────────────── public API ────────────────

    async def submit(self, request: ResearchRequest) -> str:
        async with self._global_lock:
            if request.job_id in self._jobs:
                return request.job_id
            job = _Job(
                request=request,
                sources=_resolved_internal_sources(request.source_refs),
            )
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
        return AdapterHealth(
            ok=True,
            adapter_name=self.name,
            details={"llm_spec": self._llm_spec},
        )

    # ─────────────── internals ────────────────

    def _require_job(self, job_id: str) -> _Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise AdapterError(
                code="AI_JOB_NOT_FOUND",
                message=f"gpt_researcher adapter has no job {job_id}",
            )
        return job

    def _snapshot(self, job: _Job) -> AdapterStatus:
        cost_cents = int(job.cost_usd * 100) if job.cost_usd else 0
        return AdapterStatus(
            job_id=job.request.job_id,
            status=job.status,
            current_step=job.current_step,
            attempts=job.attempts,
            sources=tuple(job.sources),
            cost=CostMetrics(
                token_input_total=job.token_in,
                token_output_total=job.token_out,
                cost_cents=cost_cents,
                search_count=job.search_count,
            ),
            error_code=job.error_code,
            error_message=job.error_message,
            output_text=job.body or None,
            output_metadata={"is_inferred": True} if job.inferred else None,
        )

    async def _run(self, job: _Job) -> None:
        """Drive research: full gpt-researcher for research_report,
        lightweight single-LLM-call for summary_brief."""
        async with job.lock:
            job.status = AI_JOB_STATUS["RUNNING"]  # type: ignore[assignment]
            job.attempts += 1

        if job.request.report_type == "summary_brief":
            await self._run_brief(job)
            return

        # Snapshot env so we can restore after gpt-researcher mutates it.
        # gpt-researcher reads ANTHROPIC_API_KEY / *_LLM at construction
        # time, but we must NOT leak heavy creds into the process-wide
        # env (which would corrupt _run_brief / distilled_scorer later).
        _saved_env = {
            "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY"),
            "ANTHROPIC_BASE_URL": os.environ.get("ANTHROPIC_BASE_URL"),
            "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY"),
            "OPENAI_BASE_URL": os.environ.get("OPENAI_BASE_URL"),
            "SMART_LLM": os.environ.get("SMART_LLM"),
            "FAST_LLM": os.environ.get("FAST_LLM"),
            "STRATEGIC_LLM": os.environ.get("STRATEGIC_LLM"),
        }
        try:
            # Configure environment for gpt-researcher's Config class.
            # Use heavy-tier credentials (Shopee compass gateway) so
            # LangChain's ChatAnthropic routes to the heavy endpoint.
            os.environ["SMART_LLM"] = self._llm_spec
            os.environ["FAST_LLM"] = self._fast_llm
            os.environ["STRATEGIC_LLM"] = self._strategic_llm
            for provider in {"ANTHROPIC", "OPENAI"}:
                heavy_key = os.environ.get(f"{provider}_API_KEY_HEAVY")
                heavy_url = os.environ.get(f"{provider}_BASE_URL_HEAVY")
                if heavy_key:
                    os.environ[f"{provider}_API_KEY"] = heavy_key
                if heavy_url:
                    os.environ[f"{provider}_BASE_URL"] = heavy_url
            os.environ.setdefault("RETRIEVER", "tavily")
            os.environ.setdefault("LANGUAGE", "chinese")
            os.environ.setdefault("TOTAL_WORDS", "800")
            os.environ.setdefault("MAX_SEARCH_RESULTS_PER_QUERY", "5")
            os.environ.setdefault("MAX_URLS_TO_SCRAPE", "10")
            # Bypass embeddings (proxy may not serve /v1/embeddings).
            os.environ.setdefault("COMPRESSION_THRESHOLD", "999999")
            os.environ.setdefault("SIMILARITY_THRESHOLD", "0")
            os.environ.pop("DOC_PATH", None)

            source_urls: list[str] = []
            for ref in job.request.source_refs:
                value = ref.get("value")
                if ref.get("type") == "url" and isinstance(value, str):
                    source_urls.append(value)

            complement = job.request.source_policy != "only_user_sources"

            ws = _StepCaptureWebSocket(job)

            researcher = GPTResearcher(
                query=job.request.topic,
                report_type="research_report",
                report_source="web",
                source_urls=source_urls or None,
                complement_source_urls=complement if source_urls else False,
                websocket=ws,
                verbose=False,
            )

            if job.cancel_event.is_set():
                return

            await researcher.conduct_research()

            if job.cancel_event.is_set():
                return

            report = await researcher.write_report()
            cost_usd = researcher.get_costs()
            captured = (
                list(researcher.get_research_sources())
                if hasattr(researcher, "get_research_sources")
                else []
            )
            visited = (
                list(researcher.visited_urls)
                if hasattr(researcher, "visited_urls")
                else []
            )
            sources = _collect_sources_from_research(
                captured,
                visited,
                job.request.topic,
            )
            report = await _ensure_complete_report(researcher, report, sources)

            async with job.lock:
                job.body = report
                job.cost_usd = cost_usd
                job.search_count = len(sources)
                job.sources = sources
                job.current_step = cast("AiJobStep", AI_JOB_STEP["WRITE"])

            if not sources:
                # DB CHECK ai_jobs_partial_sources_valid requires succeeded
                # jobs to carry at least one source; fail loudly instead of
                # letting the worker retry into WORKER_RETRY_EXHAUSTED.
                await self._mark_failed(
                    job,
                    "NO_SOURCES_FOUND",
                    "调研未收集到任何可访问来源，已中止生成草稿",
                )
                return

            if job.cancel_event.is_set():
                return

            async with job.lock:
                job.status = AI_JOB_STATUS["SUCCEEDED"]  # type: ignore[assignment]
                job.completion_event.set()

        except AdapterError as exc:
            await self._mark_failed(job, exc.code, exc.message)
        except Exception as exc:  # pragma: no cover — defensive
            await self._mark_failed(
                job, "INTERNAL", f"gpt_researcher crashed: {type(exc).__name__}"
            )
        finally:
            # Restore env so light-tier callers (_run_brief / scorer)
            # are not contaminated by heavy creds.
            for key, prior in _saved_env.items():
                if prior is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = prior

    async def _run_brief(self, job: _Job) -> None:
        """Lightweight summary generation — single LLM call, no gpt-researcher.

        Used by radar sync (``summary_brief``) and chat. Calls the shared
        provider-neutral client, bypassing gpt-researcher's heavy
        planner-executor-publisher pipeline.
        """
        from ai_engine.llm.client import generate_text, sanitize_llm_error
        from ai_engine.fetcher.ai_source_urls import _fetch_user_url

        for ref in job.request.source_refs:
            if ref.get("type") != "url":
                continue
            try:
                fetched = await _fetch_user_url(ref, request_id=job.request.request_id)
            except AdapterError as exc:
                if ref.get("required") is True:
                    await self._mark_failed(job, exc.code, exc.message)
                    return
                continue
            if fetched.is_accessible:
                job.sources.append(fetched.adapter_source)
            elif ref.get("required") is True:
                await self._mark_failed(
                    job,
                    fetched.error_code or "NO_SOURCES_FOUND",
                    "required URL source is not accessible",
                )
                return

        if job.request.source_policy == "only_user_sources" and not job.sources:
            await self._mark_failed(
                job,
                "NO_SOURCES_FOUND",
                "指定资料不存在、不可见或没有可摘要内容",
            )
            return

        topic = job.request.topic
        context = (job.request.context or "").strip()
        src_lines = "\n".join(
            f"- {s.title or s.canonical_key}: {s.snippet or ''}"
            for s in job.sources
        ) if job.sources else ""

        user_content = (
            f"请用中文为以下内容写一段简洁的摘要，保留关键事实，不要虚构。必须输出完整的句子，不能在半截处结束。\n\n"
            f"标题: {topic}\n"
        )
        if context:
            user_content += f"上下文: {context[:1000]}\n"
        if src_lines:
            user_content += f"来源:\n{src_lines[:2000]}\n"
        user_content += "\n摘要:"

        try:
            result = await generate_text(
                llm_spec=self._brief_llm,
                user_prompt=user_content,
                max_tokens=1024,
                timeout=60.0,
                disable_thinking=True,
            )
            body = result.text
            if not body:
                raise RuntimeError(
                    "LLM returned no text "
                    f"(requested={result.requested_model}, actual={result.actual_model})"
                )

            async with job.lock:
                job.body = body
                job.token_in = result.input_tokens
                job.token_out = result.output_tokens
                job.current_step = cast("AiJobStep", AI_JOB_STEP["WRITE"])
                job.cost_usd = 0.0
                if not job.sources:
                    job.inferred = True
                job.status = AI_JOB_STATUS["SUCCEEDED"]  # type: ignore[assignment]
                job.completion_event.set()
        except Exception as exc:
            await self._mark_failed(
                job, "AI_ENGINE_UNAVAILABLE",
                f"brief LLM call failed: {sanitize_llm_error(exc)}",
            )

    async def _mark_failed(self, job: _Job, code: str, message: str) -> None:
        async with job.lock:
            if (
                len(job.sources) >= PARTIAL_MIN_SOURCES
                and code in ("AI_ENGINE_UNAVAILABLE", "WORKER_TIMEOUT")
            ):
                job.status = AI_JOB_STATUS["PARTIAL"]  # type: ignore[assignment]
            else:
                job.status = AI_JOB_STATUS["FAILED"]  # type: ignore[assignment]
            job.error_code = code
            job.error_message = (message or "")[:500]
            job.completion_event.set()


def make_job_id() -> str:
    """Convenience for spike / tests that don't have a DB row yet."""
    return str(uuid.uuid4())


__all__ = ["GptResearcherAdapter", "make_job_id"]
