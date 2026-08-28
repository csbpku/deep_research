"""AI research follow-up chat endpoint — SSE contract with the fake adapter."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.adapters.base import ResearchRequest
from ai_engine.server.research_chat import _clean_model_text, router


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.state.adapter = FakeAdapter()

    @app.middleware("http")
    async def set_request_id(request: Request, call_next):
        request.state.request_id = "test-request"
        return await call_next(request)

    return TestClient(app)


def test_follow_up_streams_done_frame_with_report_grounding() -> None:
    client = _make_client()
    with client.stream(
        "POST",
        "/api/ai-research/chat/follow-up",
        json={
            "user_id": "11111111-1111-4111-8111-111111111111",
            "report_title": "GraphRAG 调研",
            "report_content": "结论：GraphRAG 适合当前规模。",
            "history": [{"role": "user", "content": "前期问题"}, {"role": "assistant", "content": "前期回答"}],
            "question": "再展开讲讲风险",
        },
    ) as response:
        assert response.status_code == 200
        body = "".join(response.iter_text())

    assert 'event: start' in body
    assert 'event: delta' in body
    assert 'event: done' in body
    assert '"content":' in body
    assert 'event: error' not in body


def test_follow_up_rejects_empty_question() -> None:
    client = _make_client()
    response = client.post(
        "/api/ai-research/chat/follow-up",
        json={"user_id": "u", "report_title": "t", "report_content": "", "history": [], "question": "   "},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "VALIDATION_FAILED"


def test_follow_up_uses_chat_mode_prompt_and_system_instructions() -> None:
    """Follow-up must behave as chat, not summary, and keep the no-reasoning guard."""

    class CaptureAdapter(FakeAdapter):
        def __init__(self) -> None:
            super().__init__()
            self.captured: ResearchRequest | None = None

        async def submit(self, request: ResearchRequest) -> str:
            self.captured = request
            return await super().submit(request)

    adapter = CaptureAdapter()
    app = FastAPI()
    app.include_router(router)
    app.state.adapter = adapter

    @app.middleware("http")
    async def set_request_id(request: Request, call_next):
        request.state.request_id = "test-request"
        return await call_next(request)

    client = TestClient(app)
    with client.stream(
        "POST",
        "/api/ai-research/chat/follow-up",
        json={
            "user_id": "22222222-2222-4222-8222-222222222222",
            "report_title": "GraphRAG 调研",
            "report_content": "结论：GraphRAG 适合当前规模。",
            "history": [],
            "question": "再展开讲讲风险",
        },
    ) as response:
        body = "".join(response.iter_text())

    assert 'event: error' not in body
    assert adapter.captured is not None
    assert adapter.captured.request_id.startswith("chat-")
    assert "不要展示内部推理过程" in (adapter.captured.context or "")


def test_clean_model_text_strips_closed_and_unclosed_think_blocks() -> None:
    assert _clean_model_text("<think>内部推理</think>\n这是最终回答。") == "这是最终回答。"
    assert _clean_model_text("<think>未闭合的推理") == ""
