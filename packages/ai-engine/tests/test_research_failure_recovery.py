"""Regressions for the Grok research timeout and identical-fallback failure."""

import asyncio
from dataclasses import replace
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
    adapter, job, audit = configure(monkeypatch)
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
        return SimpleNamespace(text="# Research\n\n" + "Grounded findings from captured evidence. " * 30 + "[S1]")

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
        assert "[S1]" not in job.body
        assert "[Source 0](https://example.test/0)" in job.body
        assert audit[0].used_fallback is False
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


@pytest.mark.asyncio
@pytest.mark.parametrize("finish_reason", ["length", "max_tokens"])
async def test_primary_truncated_writer_reaches_recovery(
    monkeypatch: pytest.MonkeyPatch, finish_reason: str,
) -> None:
    async def generate(**_: Any) -> SimpleNamespace:
        return SimpleNamespace(text="Readable but cut off. " * 30, finish_reason=finish_reason)

    monkeypatch.setattr("ai_engine.llm.client.generate_text", generate)
    result = await gr._write_report_with_bounded_client(
        llm_spec="minimax:test", topic="Grok Bot", context="captured",
        prompt="Write a report", report_length="standard", request_id="truncated-writer",
    )
    assert result == ""


@pytest.mark.asyncio
@pytest.mark.parametrize("second_truncated", [True, False])
async def test_recovery_rewrites_truncated_output_and_never_publishes_incomplete_text(
    monkeypatch: pytest.MonkeyPatch, second_truncated: bool,
) -> None:
    _, job, _ = configure(monkeypatch)
    calls: list[dict[str, Any]] = []

    async def generate(**kwargs: Any) -> SimpleNamespace:
        calls.append(kwargs)
        truncated = len(calls) == 1 or second_truncated
        return SimpleNamespace(
            text="# Research\n\n" + "Grounded findings from captured evidence. " * 30 + "[S1]",
            truncated=truncated,
            finish_reason="length" if truncated else "stop",
        )

    monkeypatch.setattr("ai_engine.llm.client.generate_text", generate)
    report = await gr._recover_empty_report(
        "", topic="我想学习一下grok bot", sources=job.sources,
        request_id="truncated-recovery", report_type="web_brief",
        context="研究目标：学习概念和如何上手",
    )
    assert len(calls) == 2
    assert "1000" not in calls[1]["user_prompt"]
    assert "1800" not in calls[0]["user_prompt"]
    assert calls[0]["max_tokens"] == 16384
    assert calls[1]["max_tokens"] == 32768
    assert calls[0]["retry_attempts"] == calls[1]["retry_attempts"] == 0
    assert "[S1]" in calls[0]["user_prompt"]
    assert "不是采购建议" in calls[0]["user_prompt"]
    if second_truncated:
        assert not gr._report_has_narrative(report)
        assert "研究结论：待补写" in report
    else:
        assert gr._report_has_narrative(report)
        assert "Grounded findings" in report


@pytest.mark.asyncio
@pytest.mark.parametrize("budget", [180, 360])
@pytest.mark.parametrize("effort", ["low", "high"])
async def test_primary_writer_gives_a_single_route_its_deadline_and_keeps_full_output_budget(
    monkeypatch: pytest.MonkeyPatch, budget: int, effort: str,
) -> None:
    spec = "minimax:MiniMax-M3.1-Flash"
    monkeypatch.setenv("FALLBACK_LLM", spec)
    monkeypatch.setenv("REPORT_WRITER_REASONING_EFFORT", effort)
    monkeypatch.setattr(gr, "_report_write_timeout_seconds", lambda: budget)
    seen: dict[str, Any] = {}

    async def generate(**kwargs: Any) -> SimpleNamespace:
        seen.update(kwargs)
        return SimpleNamespace(text="A complete long report.", truncated=False, finish_reason="stop")

    monkeypatch.setattr("ai_engine.llm.client.generate_text", generate)
    await gr._write_report_with_bounded_client(
        llm_spec=spec, topic="Grok Bot", context="real evidence packet",
        prompt="Write a detailed report without shortening it.",
        report_length="deep", request_id="primary-deadline",
    )
    assert seen["timeout"] == budget - 5
    assert seen["timeout"] > 75
    assert seen["max_tokens"] == 16384
    assert seen["retry_attempts"] == 0
    assert seen["tier"] == "heavy"
    assert seen["disable_thinking"] is (effort == "low")
    assert "without shortening" in seen["user_prompt"]


@pytest.mark.parametrize(
    ("length", "override", "expected"),
    [("brief", None, 4096), ("standard", None, 8192), ("deep", None, 16384),
     ("deep", "24000", 24000), ("deep", "999999", 32768), ("deep", "invalid", 16384)],
)
def test_report_output_budget_is_configurable(
    monkeypatch: pytest.MonkeyPatch, length: str, override: str | None, expected: int,
) -> None:
    monkeypatch.delenv("REPORT_WRITER_MAX_TOKENS", raising=False)
    if override is not None:
        monkeypatch.setenv("REPORT_WRITER_MAX_TOKENS", override)
    assert gr._report_max_tokens(length) == expected


def test_evidence_packet_preserves_later_sources_and_longer_excerpts(monkeypatch: pytest.MonkeyPatch) -> None:
    _, job, _ = configure(monkeypatch)
    source = job.sources[0]
    sources = [
        replace(source, title=f"Source {index}", canonical_key=f"https://example.com/{index}",
                source_ref={"type": "url", "value": f"https://example.com/{index}"},
                snippet=f"Evidence {index} " + "Detailed grounded documentation. " * 350)
        for index in range(48)
    ]
    packet = gr._format_evidence_packet(sources)
    assert "[S48]" in packet
    assert "Evidence 47" in packet
    assert len(packet) <= 120000
    assert len(packet) > 90000


def test_primary_writer_prompt_contains_the_full_research_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    _, job, _ = configure(monkeypatch)
    context = "Prior requirements. " * 1500 + "FINAL REQUIREMENT: compare deployment rollback safety."
    prompt = gr._build_grounded_report_prompt(
        {}, job.sources, topic="Learning Grok Bot", context=context,
    )
    assert "Learning Grok Bot" in prompt
    assert context in prompt
    assert "FINAL REQUIREMENT: compare deployment rollback safety." in prompt


@pytest.mark.asyncio
async def test_recovery_has_an_outer_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    _, job, _ = configure(monkeypatch)
    cancelled = False

    async def stalled(**kwargs: Any) -> SimpleNamespace:
        nonlocal cancelled
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled = True
            raise
        return SimpleNamespace(text="never")

    # Let the deliberately tiny test deadline enter the guarded request.
    monkeypatch.setattr(gr, "_report_recovery_timeout_seconds", lambda: 1.05)
    monkeypatch.setattr("ai_engine.llm.client.generate_text", stalled)
    report = await gr._recover_empty_report("", topic="Grok Bot", sources=job.sources, request_id="deadline")
    assert cancelled
    assert not gr._report_has_narrative(report)


@pytest.mark.asyncio
async def test_primary_writer_reserves_time_for_a_distinct_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FALLBACK_LLM", "deepseek:test")
    monkeypatch.setattr(gr, "_report_write_timeout_seconds", lambda: 360)
    seen: dict[str, Any] = {}

    async def generate(**kwargs: Any) -> SimpleNamespace:
        seen.update(kwargs)
        return SimpleNamespace(text="Complete report.")

    monkeypatch.setattr("ai_engine.llm.client.generate_text", generate)
    await gr._write_report_with_bounded_client(
        llm_spec="minimax:MiniMax-M3.1-Flash", topic="Grok Bot", context="evidence",
        prompt="Write a report.", report_length="deep", request_id="distinct-fallback-budget",
    )
    assert seen["timeout"] == 177.5
    assert seen["retry_attempts"] == 0
