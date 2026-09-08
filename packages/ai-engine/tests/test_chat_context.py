from __future__ import annotations

import asyncio

import pytest

from ai_engine.adapters.base import ResearchRequest
from ai_engine.adapters.gpt_researcher import GptResearcherAdapter
from ai_engine.contracts.states import SOURCE_POLICY


@pytest.mark.asyncio
async def test_chat_brief_keeps_full_context(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    async def fake_generate_text(**kwargs: object) -> object:
        captured.update(kwargs)

        class Result:
            text = "可以从正文判断。"
            input_tokens = 100
            output_tokens = 10

        return Result()

    monkeypatch.setattr("ai_engine.llm.client.generate_text", fake_generate_text)
    adapter = GptResearcherAdapter(brief_llm="openai:test")
    tail_marker = "AFL-CALCULATION-DETAILS-IN-FULL-TEXT"
    request = ResearchRequest(
        job_id="chat-context-test",
        request_id="chat-session-test",
        topic="论文问题",
        context=("正文开头\n" + ("中间正文 " * 1200) + tail_marker),
        report_type="summary_brief",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],
        source_refs=(),
        timeout_seconds=10,
    )

    await adapter.submit(request)
    for _ in range(20):
        status = await adapter.get_status(request.job_id)
        if status.status in {"succeeded", "failed", "partial", "cancelled"}:
            break
        await asyncio.sleep(0.01)

    assert status.status == "succeeded"
    prompt = str(captured["user_prompt"])
    assert tail_marker in prompt
    assert "请直接回答用户最后的问题" in prompt
    assert captured["max_tokens"] == 4096
