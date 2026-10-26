"""Regressions for the Grok research timeout and identical-fallback failure."""

from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from openai import APITimeoutError

from ai_engine.adapters import gpt_researcher as gr
from ai_engine.adapters.base import AdapterSource, ResearchRequest


def timeout() -> APITimeoutError:
    return APITimeoutError(request=httpx.Request("POST", "https://llm.example.test"))


def configure(monkeypatch: pytest.MonkeyPatch) -> tuple[gr.GptResearcherAdapter, gr._Job, list[Any]]:
    primary = "minimax:test-model"
    monkeypatch.setenv("RESEARCH_LLM", primary)
    monkeypatch.setenv("UTILITY_LLM", primary)
    monkeypatch.setenv("FALLBACK_LLM", primary)
    monkeypatch.setenv("RETRIEVER", "duckduckgo")
    sources = [
        AdapterSource(
            source_ref={"type": "url", "value": f"https://example.test/{index}"},
            canonical_key=f"https://example.test/{index}",
            title=f"Source {index}",
            snippet="Captured documentation with inspectable evidence. " * 20,
            score=1.0,
            step_captured="search",
        )
        for index in range(3)
    ]
    request = ResearchRequest(
        job_id="grok-timeout", request_id="grok-timeout", topic="Learning Grok Bot",
        context=None, report_type="web_brief", report_length="standard",
        source_policy="prefer_user_sources", source_refs=(),
    )
    adapter = gr.GptResearcherAdapter()
    job = gr._Job(request=request, sources=sources)
    adapter._jobs[request.job_id] = job
    audit: list[Any] = []

    async def record(attempt: Any) -> None:
        audit.append(attempt)

    async def hydrate(items: list[AdapterSource], **_: Any) -> list[AdapterSource]:
        return items

    monkeypatch.setattr(gr, "record_llm_usage", record)
    monkeypatch.setattr(gr, "_hydrate_source_snippets", hydrate)
    monkeypatch.setattr(gr, "_sources_from_researcher", lambda *_: sources)
    return adapter, job, audit


@pytest.mark.asyncio
async def test_identical_fallback_preserves_original_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter, job, audit = configure(monkeypatch)
    calls = 0

    class Researcher:
        def __init__(self, **_: Any) -> None:
            pass

        async def conduct_research(self, **_: Any) -> None:
            nonlocal calls
            calls += 1
            raise timeout()

    monkeypatch.setattr(gr, "GPTResearcher", Researcher)
    await adapter._run_impl(job)

    assert calls == 1
    assert job.status == "partial"
    assert job.error_code == "AI_ENGINE_UNAVAILABLE"
    assert "crashed" not in (job.error_message or "")
    assert audit == []  # No fake fallback or misleading quota audit.


@pytest.mark.asyncio
async def test_distinct_fallback_is_tried_and_timeout_audit_is_not_quota(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter, job, audit = configure(monkeypatch)
    monkeypatch.setenv("FALLBACK_LLM", "deepseek:test-fallback")
    calls = 0

    class Researcher:
        def __init__(self, **_: Any) -> None:
            pass

        async def conduct_research(self, **_: Any) -> None:
            nonlocal calls
            calls += 1
            raise timeout()

    monkeypatch.setattr(gr, "GPTResearcher", Researcher)
    await adapter._run_impl(job)

    assert calls == 2
    assert job.error_code == "AI_ENGINE_UNAVAILABLE"
    assert len(audit) == 1
    assert audit[0].error_kind == "APITimeoutError"
    assert audit[0].fallback_model == "deepseek:test-fallback"


@pytest.mark.asyncio
@pytest.mark.parametrize("recovery_works", [True, False])
async def test_sdk_writer_timeout_recovers_without_restarting_research(
    monkeypatch: pytest.MonkeyPatch, recovery_works: bool,
) -> None:
    adapter, job, _ = configure(monkeypatch)
    research_calls = 0
    operations: list[str] = []

    class Researcher:
        def __init__(self, **_: Any) -> None:
            self.context = ""

        async def conduct_research(self, **_: Any) -> None:
            nonlocal research_calls
            research_calls += 1

        def get_costs(self) -> float:
            return 0.0

    async def generate(**kwargs: Any) -> SimpleNamespace:
        operations.append(kwargs["operation"])
        if kwargs["operation"] == "research.report_writer" or not recovery_works:
            raise timeout()
        return SimpleNamespace(text="# Research\n\n" + "Grounded findings from captured evidence. " * 30)

    monkeypatch.setattr(gr, "GPTResearcher", Researcher)
    monkeypatch.setattr("ai_engine.llm.client.generate_text", generate)
    await adapter._run_impl(job)

    assert research_calls == 1
    assert operations == ["research.report_writer", "research.report_fallback"]
    assert job.sources
    assert job.error_code is None
    if recovery_works:
        assert job.status == "succeeded"
        assert "Grounded findings" in job.body
    else:
        assert job.status == "partial"
        assert "研究结论：待补写" in job.body


@pytest.mark.asyncio
async def test_writer_auth_error_is_not_silently_degraded(monkeypatch: pytest.MonkeyPatch) -> None:
    async def generate(**_: Any) -> None:
        raise ValueError("invalid provider configuration")

    monkeypatch.setattr("ai_engine.llm.client.generate_text", generate)
    with pytest.raises(ValueError, match="invalid provider"):
        await gr._write_report_with_bounded_client(
            llm_spec="minimax:test", topic="Grok Bot", context="captured",
            prompt="Write a report", report_length="standard", request_id="auth-error",
        )
