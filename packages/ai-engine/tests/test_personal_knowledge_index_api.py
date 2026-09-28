from __future__ import annotations

from typing import cast

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest

from ai_engine.server import personal_knowledge as api

USER_ID = "11111111-1111-4111-8111-111111111111"
RESEARCH_ID = "22222222-2222-4222-8222-222222222222"
INTERNAL_TOKEN = "test-internal-token"


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(api.router)
    return TestClient(app)


def _search(client: TestClient, *, token: str = INTERNAL_TOKEN) -> httpx.Response:
    return cast(
        httpx.Response,
        client.post(
            "/api/knowledge-index/search",
            headers={"x-internal-token": token},
            json={"userId": USER_ID, "query": "confirmed retrieval conclusion", "limit": 4},
        ),
    )


def test_semantic_search_returns_only_record_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setattr(api, "personal_knowledge_index_enabled", lambda: True)

    class FakeClient:
        def __init__(self, *, timeout_seconds: float) -> None:
            assert timeout_seconds == 2.0

        async def vector_search(self, user_id: str, query: str, *, limit: int) -> list[str]:
            assert user_id == USER_ID
            assert query == "confirmed retrieval conclusion"
            assert limit == 4
            return [RESEARCH_ID]

    monkeypatch.setattr(api, "AnythingLLMClient", FakeClient)
    response = _search(_client())

    assert response.status_code == 200
    assert response.json() == {"ids": [RESEARCH_ID], "enabled": True}
    assert "text" not in response.json()


def test_unavailable_vector_search_returns_empty_ids_for_keyword_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setattr(api, "personal_knowledge_index_enabled", lambda: True)

    class FakeClient:
        def __init__(self, *, timeout_seconds: float) -> None:
            pass

        async def vector_search(self, *_args: object, **_kwargs: object) -> list[str]:
            raise TimeoutError("synthetic timeout")

    monkeypatch.setattr(api, "AnythingLLMClient", FakeClient)
    response = _search(_client())

    assert response.status_code == 200
    assert response.json() == {"ids": [], "enabled": True}


def test_disabled_index_returns_empty_ids_without_calling_anythingllm(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setattr(api, "personal_knowledge_index_enabled", lambda: False)

    class UnexpectedClient:
        def __init__(self, **_kwargs: object) -> None:
            raise AssertionError("disabled semantic index must not call AnythingLLM")

    monkeypatch.setattr(api, "AnythingLLMClient", UnexpectedClient)
    response = _search(_client())

    assert response.status_code == 200
    assert response.json() == {"ids": [], "enabled": False}


def test_semantic_search_requires_the_internal_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", INTERNAL_TOKEN)
    monkeypatch.delenv("RADAR_DISABLE_INTERNAL_TOKEN", raising=False)
    monkeypatch.setattr(api, "personal_knowledge_index_enabled", lambda: True)
    response = _search(_client(), token="wrong-token")

    assert response.status_code == 403
