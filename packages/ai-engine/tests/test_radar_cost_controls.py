from __future__ import annotations

import asyncio
import json
import os
import socket
from typing import Any

import pytest

from ai_engine.llm import client
from ai_engine.llm.client import TextGenerationResult
from ai_engine.llm.runtime_policy import LiveModelCallsDisabled, ensure_live_calls_allowed
from ai_engine.llm.work_budget import (
    WorkBudget,
    WorkBudgetExceeded,
    bind_work_budget,
    budgeted,
    reserve_attempt,
)
from ai_engine.radar.shared_evidence import prepare_shared_evidence
from ai_engine.radar.distilled_scorer import _anthropic_scorer_impl, score_with_llm
from ai_engine.text_chunking import split_text_by_token_budget


def response(text: str = "ok", inp: int = 20, out: int = 10) -> TextGenerationResult:
    return TextGenerationResult(text, inp, out, "test-model", "test-model", "openai")


@pytest.fixture
def configured_client(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    monkeypatch.setenv("UTILITY_LLM", "openai:test-model")
    monkeypatch.setenv("OPENAI_API_KEY", "fake-key-for-tests")
    monkeypatch.setenv("FALLBACK_LLM", "openai:test-model")
    monkeypatch.setenv("LLM_USAGE_AUDIT_ENABLED", "false")
    monkeypatch.setenv("LLM_RETRY_BACKOFF_SECONDS", "0")
    monkeypatch.setenv("LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT", "0")
    monkeypatch.setenv("LLM_TOKEN_BUDGET_USER_LIMIT", "0")

    async def wire(**kwargs: Any) -> TextGenerationResult:
        calls.append(kwargs)
        await asyncio.sleep(0)
        return response()

    monkeypatch.setattr(client, "_generate_text_once", wire)
    return calls


def test_flattened_markdown_cannot_become_growing_section_metadata() -> None:
    text = "# Long page " + "evidence method result " * 7000
    chunks = split_text_by_token_budget(text, 6000)
    assert len(chunks) > 10
    assert "".join(c.text for c in chunks) == text
    assert all(len(c.section) <= 160 for c in chunks)
    assert not any(c.section for c in chunks)


def test_section_whitespace_never_crosses_a_line() -> None:
    text = "#\nnot a heading\n## Real heading\n\nBody.\n"
    assert split_text_by_token_budget(text, 6000)[0].section == ""


async def test_sibling_calls_cannot_oversubscribe_token_allowance(
    configured_client: list[dict[str, Any]],
) -> None:
    b = WorkBudget("source", 20, 200)
    with bind_work_budget(b):
        results = await asyncio.gather(
            *(client.generate_text(user_prompt="hello", max_tokens=100) for _ in range(12)),
            return_exceptions=True,
        )
    assert len(configured_client) == 1
    assert sum(isinstance(r, WorkBudgetExceeded) for r in results) == 11
    assert b.calls == 1
    assert (b.input_tokens, b.output_tokens, b.pending_tokens) == (20, 10, 0)


async def test_transport_retry_uses_same_article_allowance(
    configured_client: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unavailable(**kwargs: Any) -> TextGenerationResult:
        configured_client.append(kwargs)
        raise ConnectionError("transport failed after send")

    monkeypatch.setattr(client, "_generate_text_once", unavailable)
    with bind_work_budget(WorkBudget("article", 1, 1000)) as b:
        with pytest.raises(WorkBudgetExceeded):
            await client.generate_text(user_prompt="hello", max_tokens=100)
    assert len(configured_client) == 1
    assert b.charged_tokens >= 100  # Unknown failures don't replenish capacity.
    assert b.pending_tokens == 0


async def test_run_budget_survives_nested_sync_retry_and_cancellation() -> None:
    @budgeted("radar_run")
    async def nested() -> None:
        with reserve_attempt(10):
            await asyncio.sleep(0)
            raise asyncio.CancelledError()

    b = WorkBudget("radar_run", 1, 10)
    with bind_work_budget(b):
        with pytest.raises(asyncio.CancelledError):
            await nested()
        with pytest.raises(WorkBudgetExceeded):
            await nested()
    assert b.calls == 1
    assert b.charged_tokens == 10
    assert b.pending_tokens == 0


async def test_all_paid_stages_feed_source_usage(configured_client: list[dict[str, Any]]) -> None:
    source = WorkBudget("source", 8, 10000)
    with bind_work_budget(source):
        for operation in ["radar.evidence", "research.summary_brief", "radar.distilled_score"]:
            await client.generate_text(user_prompt="source evidence", operation=operation)
    assert len(configured_client) == 3
    assert (source.input_tokens, source.output_tokens) == (60, 30)


async def test_shared_long_source_is_read_once_and_score_does_not_map_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []
    marker = "The measured result has a documented limitation."
    content = "# Method\n\n" + (marker + "\n\n") * 2200

    async def fake_generate(**kwargs: Any) -> TextGenerationResult:
        calls.append(kwargs)
        if "evidence_extract" in kwargs.get("request_id", ""):
            return response(
                json.dumps(
                    {
                        "coverage": "结果与限制",
                        "evidence": [{"aspect": "验证", "quote": marker, "observation": "有明确实验与限制"}],
                        "risk_signals": [{"quote": marker, "observation": "已陈述适用边界"}],
                    }
                )
            )
        return response(
            '{"信息增量":2,"分析深度":2,"可行动性":2,"事实可信度":2,"时效性":2,"表达质量":2,"综合信号":2}'
        )

    monkeypatch.setattr(client, "generate_text", fake_generate)
    shared = await prepare_shared_evidence("Measured method", content)
    assert shared.source_chunks > 3
    assert shared.selected_chunks == 3
    assert shared.is_excerpt
    assert len(calls) == 3
    assert marker in shared.text
    assert "risk_signals" in shared.text
    await _anthropic_scorer_impl(
        "Measured method",
        content,
        source_evidence=shared.text,
        content_is_source_excerpt=True,
    )
    assert len(calls) == 4
    assert "final_score" in calls[-1]["request_id"]
    assert "仅为信息源片段" in calls[-1]["user_prompt"] or "片段" in calls[-1]["user_prompt"]
    assert content not in calls[-1]["user_prompt"]


async def test_scorer_does_not_convert_work_budget_into_fake_score(monkeypatch: pytest.MonkeyPatch) -> None:
    async def exhausted(*args: Any, **kwargs: Any) -> str:
        raise WorkBudgetExceeded("radar_article")

    with pytest.raises(WorkBudgetExceeded):
        await score_with_llm("Title", "Source " * 100, scorer=exhausted)


def test_local_live_calls_require_both_opt_in_and_positive_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_RUNTIME_ENV", "development")
    monkeypatch.delenv("LLM_ALLOW_LIVE_CALLS", raising=False)
    with pytest.raises(LiveModelCallsDisabled):
        ensure_live_calls_allowed()
    monkeypatch.setenv("LLM_ALLOW_LIVE_CALLS", "1")
    monkeypatch.setenv("LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT", "0")
    with pytest.raises(LiveModelCallsDisabled):
        ensure_live_calls_allowed()
    monkeypatch.setenv("LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT", "50000")
    ensure_live_calls_allowed()


@pytest.mark.parametrize("host,port", [("198.51.100.10", 443), ("127.0.0.1", 8318), ("::1", 15721)])
def test_unit_suite_blocks_external_models_and_local_model_proxies(host: str, port: int) -> None:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family) as sock:
        with pytest.raises(RuntimeError, match="Test attempted external network"):
            sock.connect((host, port))


async def test_shared_evidence_bounds_verbose_cjk_packets_without_dropping_risks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    quote = "证据" * 40
    content = (quote + "\n\n") * 200

    async def verbose(**kwargs: Any) -> TextGenerationResult:
        return response(
            json.dumps(
                {
                    "coverage": "概述" * 150,
                    "evidence": [{"aspect": "方面" * 25, "quote": quote, "observation": "观察" * 60}],
                    "risk_signals": [{"quote": quote, "observation": "风险" * 60}] * 2,
                    "repost_signal": "转载" * 60,
                },
                ensure_ascii=False,
            )
        )

    monkeypatch.setattr(client, "generate_text", verbose)
    shared = await prepare_shared_evidence("中文论文", content)
    packets = json.loads(shared.text)
    assert len(packets) == 3
    assert all(len(p["risk_signals"]) == 2 and p["repost_signal"] for p in packets)
    assert shared.is_excerpt


@pytest.mark.parametrize("kind", ["brief", "score"])
async def test_failed_reducer_cancels_and_awaits_paid_siblings(
    kind: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ai_engine.adapters import gpt_researcher as gpt
    from ai_engine.radar import distilled_scorer as scoring

    entered = 0
    both_started = asyncio.Event()
    cancelled = asyncio.Event()

    async def reduce_call(*args: Any, **kwargs: Any) -> TextGenerationResult:
        nonlocal entered
        entered += 1
        first = entered == 1
        if entered >= 2:
            both_started.set()
        if first:
            await both_started.wait()
            raise ValueError("bad structured packet")
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
        raise AssertionError("unreachable")

    packets = [{"summary": "证据" * 50, "coverage": "事实" * 50} for _ in range(4)]
    if kind == "brief":
        monkeypatch.setattr(gpt, "BRIEF_REDUCE_INPUT_TOKEN_BUDGET", 1)
        monkeypatch.setattr(gpt, "BRIEF_REDUCE_BATCH_TOKEN_BUDGET", 1100)
        operation = gpt.GptResearcherAdapter()._reduce_brief_notes(
            reduce_call, packets, original_content="source"
        )
    else:
        monkeypatch.setattr(scoring, "SCORING_EVIDENCE_TOKEN_BUDGET", 1)
        monkeypatch.setattr(scoring, "SCORING_REDUCE_BATCH_TOKEN_BUDGET", 1100)
        operation = scoring._reduce_scoring_evidence(
            reduce_call, llm_spec="openai:test", packets=packets, original_content="source"
        )
    with pytest.raises(ValueError, match="bad structured packet"):
        await asyncio.wait_for(operation, 2)
    assert entered >= 2 and cancelled.is_set()


def test_unit_suite_does_not_write_developer_usage_ledger() -> None:
    assert os.environ["LLM_USAGE_AUDIT_ENABLED"] == "false"
