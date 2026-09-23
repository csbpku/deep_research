from types import SimpleNamespace

import httpx

from ai_engine.server.app import ResearchAssistantBody, _extract_json_object, _reading_answer_payload, _strip_reasoning_blocks, app


def test_research_assistant_accepts_dedicated_translate_operation() -> None:
    body = ResearchAssistantBody(
        operation="translate",
        body="Translate this paragraph.",
        instruction="Translate to zh-CN.",
    )

    assert body.operation == "translate"


def test_research_assistant_accepts_browser_reader_follow_up() -> None:
    body = ResearchAssistantBody(
        operation="ask",
        body="The original page context.",
        topic="Browser reading",
        instruction="Why does this matter for system design?",
    )

    assert body.operation == "ask"


def test_research_assistant_accepts_explicit_knowledge_card_operation() -> None:
    body = ResearchAssistantBody(
        operation="knowledge_card",
        body="把这条回答压缩成一张短知识卡片。",
        topic="知识卡片",
    )

    assert body.operation == "knowledge_card"


def test_reasoning_markup_is_removed_from_reader_output() -> None:
    assert _strip_reasoning_blocks(
        "<think>内部推理，不应展示。</think>\n真正的摘要。"
    ) == "真正的摘要。"
    assert _strip_reasoning_blocks(
        "<think>未闭合的内部推理"
    ) == ""


def test_json_recovery_ignores_reasoning_markup() -> None:
    assert _extract_json_object(
        "<think>先分析，再输出。</think>\n{\"version\": 2}"
    ) == {"version": 2}


def test_reader_answer_discards_evidence_not_present_in_page_context() -> None:
    result = _reading_answer_payload(
        '{"answer":"回答","evidence":[{"quote":"页面中的证据","claim":"支持"},{"quote":"模型编造的句子","claim":"不应显示"}],"background":"背景","inference":"推断","limitations":["限制"]}',
        "页面中的证据。",
        "页面中的证据",
    )
    assert result["answer"] == "回答"
    assert result["evidence"] == [{"quote": "页面中的证据", "claim": "支持"}]
    assert any("无法在当前原文中精确找到" in warning for warning in result["warnings"])


async def test_reading_assistant_stream_emits_provider_deltas(monkeypatch) -> None:
    async def fake_stream_text(*, on_delta, **_kwargs):
        await on_delta("流式回答")
        return SimpleNamespace(
            text="流式回答",
            input_tokens=3,
            output_tokens=2,
            requested_model="test-model",
            actual_model="test-model",
            provider="fake",
            finish_reason="stop",
            truncated=False,
        )

    monkeypatch.setattr("ai_engine.server.app.stream_text", fake_stream_text)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/ai/research-assistant/stream",
            json={"operation": "ask", "body": "当前原文", "instruction": "解释", "topic": "测试"},
        )

    assert response.status_code == 200
    assert "event: delta" in response.text
    assert '流式回答' in response.text
    assert '"streaming": true' in response.text
