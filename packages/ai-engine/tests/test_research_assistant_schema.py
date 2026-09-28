import base64
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest

from ai_engine.llm.client import TextGenerationResult
from ai_engine.server import app as app_module
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


def test_research_assistant_accepts_full_page_beyond_old_character_cap() -> None:
    text = "x" * 300_000
    body = ResearchAssistantBody(operation="ask", body=text, scope="page")
    assert body.body == text
    assert body.scope == "page"


@pytest.mark.asyncio
async def test_full_page_answer_reserves_before_covering_all_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[str] = []
    prompts: list[str] = []
    reservations: list[int] = []
    monkeypatch.setenv("READER_ANSWER_CHUNK_TOKENS", "1000")

    @asynccontextmanager
    async def fake_reserve(**kwargs: object):
        events.append("reserve")
        reservations.append(int(kwargs["estimated_tokens"]))
        yield SimpleNamespace(actual_tokens=0)

    async def fake_generate_text(**kwargs: object) -> TextGenerationResult:
        events.append("generate")
        prompts.append(str(kwargs["user_prompt"]))
        return TextGenerationResult(
            text='{"answer":"全篇结论","evidence":[]}',
            input_tokens=100,
            output_tokens=20,
            requested_model="test:model",
            actual_model="test:model",
            provider="test",
        )

    monkeypatch.setattr(app_module, "reserve_llm_token_task", fake_reserve)
    monkeypatch.setattr(app_module, "generate_text", fake_generate_text)
    monkeypatch.setenv("LLM_TOKEN_BUDGET_USER_LIMIT", "0")
    monkeypatch.setenv("LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT", "0")
    text = f"START_SENTINEL\n\n{'complete paragraph. ' * 5_000}\n\nEND_SENTINEL"
    body = ResearchAssistantBody(
        operation="ask",
        body=text,
        scope="page",
        requester_id="11111111-1111-4111-8111-111111111111",
    )

    result = await app_module._generate_full_page_answer(body, request_id="request-1")

    assert result is not None
    assert len(prompts) > 2
    joined = "\n".join(prompts)
    assert "START_SENTINEL" in joined
    assert "END_SENTINEL" in joined
    assert reservations[0] > 0
    assert events[0] == "reserve"
    assert events[1] == "generate"


@pytest.mark.asyncio
async def test_full_draft_summary_covers_the_body_and_reserves_the_whole_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    prompts: list[str] = []

    @asynccontextmanager
    async def fake_reserve(**_kwargs: object):
        events.append("reserve")
        yield SimpleNamespace(actual_tokens=0)

    async def fake_generate_text(**kwargs: object) -> TextGenerationResult:
        events.append("generate")
        prompts.append(str(kwargs["user_prompt"]))
        return TextGenerationResult(
            text="分块摘要",
            input_tokens=100,
            output_tokens=20,
            requested_model="test:model",
            actual_model="test:model",
            provider="test",
        )

    monkeypatch.setattr(app_module, "reserve_llm_token_task", fake_reserve)
    monkeypatch.setattr(app_module, "generate_text", fake_generate_text)
    monkeypatch.setenv("RESEARCH_ASSISTANT_CHUNK_TOKENS", "1000")
    text = f"DRAFT_START\n\n{'complete research paragraph. ' * 5_000}\n\nDRAFT_END"
    body = ResearchAssistantBody(operation="summarize", body=text)

    result = await app_module._generate_full_draft_operation(body, request_id="draft-request")

    assert result is not None
    assert len(prompts) > 2
    assert "DRAFT_START" in "\n".join(prompts)
    assert "DRAFT_END" in "\n".join(prompts)
    assert events[0] == "reserve"
    assert events[1] == "generate"


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


def test_reader_answer_recovers_only_verbatim_quotes_from_plain_markdown() -> None:
    quote = "How to transform your software development lifecycle with AI—stage by stage."
    raw = f'核心目标是分阶段改造 SDLC。\n\n原文证据：\n"{quote}"\n\n因此，逐步推进。'

    result = _reading_answer_payload(raw, f"Lead. {quote} Follow.", "")

    assert result["structured"] is False
    assert result["answer"] == raw
    assert result["evidence"] == [{
        "quote": quote,
        "claim": "回答中的引文已与当前正文逐字核对。",
    }]
    assert "回答中的引文已与当前正文逐字核对。" in result["warnings"]


def test_reader_answer_does_not_recover_invented_markdown_quotes() -> None:
    result = _reading_answer_payload(
        '结论如下：“这是模型编造的引用。”',
        "这里是完全不同的正文。",
        "",
    )

    assert result["evidence"] == []
    assert "没有找到可核对的原文引文。" in result["warnings"]


def test_reader_answer_rejects_empty_model_output() -> None:
    with pytest.raises(ValueError, match="没有返回有效回答"):
        _reading_answer_payload("<think>reasoning only", "source", "")


def test_reader_answer_drops_overlong_evidence_instead_of_showing_the_full_source() -> None:
    quote = "A source passage. " * 30
    result = _reading_answer_payload(
        '{"answer":"回答 [1]","evidence":[{"quote":' + json.dumps(quote) + ',"claim":"支持"}]}',
        quote,
        quote,
    )

    assert result["evidence"] == []
    assert any("没有可核对" in warning for warning in result["warnings"])


def test_reader_answer_bounds_claims_and_verification_notes() -> None:
    quote = "A short exact source quote."
    result = _reading_answer_payload(
        json.dumps({
            "answer": "结论 [1]。",
            "evidence": [{"quote": quote, "claim": "c" * 240}],
            "limitations": ["l" * 240 for _ in range(6)],
        }),
        quote,
        "",
    )

    assert len(result["evidence"]) == 1
    assert len(result["evidence"][0]["claim"]) == 160
    assert len(result["limitations"]) == 4
    assert all(len(item) == 180 for item in result["limitations"])


async def test_reader_image_translation_accepts_only_browser_image_bytes(monkeypatch) -> None:
    calls = {}
    monkeypatch.delenv("READING_VISION_LLM", raising=False)
    monkeypatch.setenv("UTILITY_LLM", "minimax:MiniMax-M3")

    async def fake_generate_vision(**kwargs):
        calls.update(kwargs)
        return SimpleNamespace(
            text='{"hasReadableText":true,"regions":[]}',
            truncated=False,
            finish_reason="stop",
            input_tokens=100,
            output_tokens=20,
            provider="minimax",
            requested_model="MiniMax-M3",
            actual_model="MiniMax-M3",
        )

    monkeypatch.setattr("ai_engine.server.app.generate_vision", fake_generate_vision)
    image_bytes = b"\x89PNG\r\n\x1a\n"
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-internal-token": "test-only-ai-engine-token"},
    ) as client:
        response = await client.post(
            "/api/ai/reading/translate-image",
            json={
                "image_media_type": "image/png",
                "image_base64": base64.b64encode(image_bytes).decode("ascii"),
                "image_alt": "diagram",
                "topic": "Architecture",
                "language": "zh-CN",
                "requester_id": "11111111-1111-4111-8111-111111111111",
            },
        )

    assert response.status_code == 200
    assert calls["llm_spec"] == "minimax:MiniMax-M3"
    assert calls["image_media_type"] == "image/png"
    assert calls["image_base64"] == base64.b64encode(image_bytes).decode("ascii")
    assert "穷尽识别图片内每一处清晰可读文字" in calls["user_prompt"]
    assert "x、y 为紧贴字形的左上角" in calls["user_prompt"]
    assert "不要返回文字中心点" in calls["user_prompt"]
    assert response.json()["suggestion"].startswith('{"hasReadableText"')

    monkeypatch.setenv("READING_VISION_LLM", "anthropic:claude-vision")
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-internal-token": "test-only-ai-engine-token"},
    ) as client:
        override_response = await client.post(
            "/api/ai/reading/translate-image",
            json={
                "image_media_type": "image/png",
                "image_base64": base64.b64encode(image_bytes).decode("ascii"),
            },
        )

    assert override_response.status_code == 200
    assert calls["llm_spec"] == "anthropic:claude-vision"


async def test_reader_image_translation_rejects_mime_mismatch(monkeypatch) -> None:
    async def fail_if_called(**_kwargs):
        raise AssertionError("vision provider must not receive mismatched image bytes")

    monkeypatch.setattr("ai_engine.server.app.generate_vision", fail_if_called)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-internal-token": "test-only-ai-engine-token"},
    ) as client:
        response = await client.post(
            "/api/ai/reading/translate-image",
            json={"image_media_type": "image/png", "image_base64": base64.b64encode(b"not png").decode("ascii")},
        )

    assert response.status_code == 400


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
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-internal-token": "test-only-ai-engine-token"},
    ) as client:
        response = await client.post(
            "/api/ai/research-assistant/stream",
            json={"operation": "ask", "body": "当前原文", "instruction": "解释", "topic": "测试"},
        )

    assert response.status_code == 200
    assert "event: delta" in response.text
    assert '流式回答' in response.text
    assert '"streaming": true' in response.text


async def test_translation_uses_full_output_budget_and_reports_provider_truncation(monkeypatch) -> None:
    calls: dict[str, object] = {}

    async def fake_generate_text(**kwargs):
        calls.update(kwargs)
        return SimpleNamespace(
            text="完整译文",
            input_tokens=20,
            output_tokens=10,
            truncated=True,
            finish_reason="length",
        )

    monkeypatch.setattr("ai_engine.server.app.generate_text", fake_generate_text)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-internal-token": "test-only-ai-engine-token"},
    ) as client:
        response = await client.post(
            "/api/ai/research-assistant",
            json={"operation": "translate", "body": "A complete source passage.", "topic": "Test"},
        )

    assert response.status_code == 200
    assert calls["max_tokens"] == 6000
    payload = response.json()
    assert payload["suggestion"] == "完整译文"
    assert payload["truncated"] is True
    assert payload["finishReason"] == "length"
