from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.server import preflight as preflight_module
from ai_engine.server.app import app


class ConfiguredAdapter(FakeAdapter):
    name = "gpt_researcher"


@pytest.fixture(autouse=True)
def isolate_preflight(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(preflight_module, "_cache", {})
    monkeypatch.setattr(preflight_module, "_pending", {})
    for key in list(__import__("os").environ):
        if any(part in key.upper() for part in ("API_KEY", "BASE_URL", "PROTOCOL", "RETRIEVER")):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("RESEARCH_LLM", "openai:research-model")
    monkeypatch.setenv("UTILITY_LLM", "openai:utility-model")


async def test_fake_preflight_route_exists_and_requires_internal_auth() -> None:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get("/health/preflight")).status_code == 403
        response = await client.get("/health/preflight", headers={"x-internal-token": "test-only-ai-engine-token"})
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["checks"][0]["name"] == "adapter"


async def test_missing_credentials_block_before_any_network(monkeypatch: pytest.MonkeyPatch) -> None:
    probe = AsyncMock()
    monkeypatch.setattr(preflight_module, "_probe_model_directory", probe)
    result = await preflight_module.research_preflight(ConfiguredAdapter())
    assert result["ok"] is False
    assert {check["name"] for check in result["checks"] if not check["ok"]} == {"research_llm", "utility_llm"}
    probe.assert_not_awaited()


@pytest.mark.parametrize(("code", "ok", "warning"), [(200, True, False), (401, False, False), (429, False, False), (404, True, True)])
async def test_probe_uses_only_model_metadata_and_hides_provider_body(
    monkeypatch: pytest.MonkeyPatch, code: int, ok: bool, warning: bool,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "private-test-credential")
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(code, text="private-test-credential MUST NOT LEAK")

    original_client = httpx.AsyncClient
    monkeypatch.setattr(preflight_module.httpx, "AsyncClient", lambda **kwargs: original_client(
        transport=httpx.MockTransport(handle), **kwargs,
    ))
    result = await preflight_module.research_preflight(ConfiguredAdapter())
    assert result["ok"] is ok
    assert [(request.method, request.url.path) for request in requests] == [("GET", "/v1/models")]
    assert "private-test-credential" not in str(result)
    assert any(check.get("level") == "warning" for check in result["checks"]) is warning


async def test_cache_deduplicates_requests_and_bounds_forced_refresh(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    now = [0.0]
    monkeypatch.setattr(preflight_module.time, "monotonic", lambda: now[0])
    probe = AsyncMock(return_value={"name": "model_probe", "ok": True, "message": "ready"})
    monkeypatch.setattr(preflight_module, "_probe_model_directory", probe)
    await asyncio.gather(*(preflight_module.research_preflight(ConfiguredAdapter()) for _ in range(5)))
    await preflight_module.research_preflight(ConfiguredAdapter(), force=True)
    assert probe.await_count == 1
    now[0] += 6
    await preflight_module.research_preflight(ConfiguredAdapter(), force=True)
    assert probe.await_count == 2


async def test_checks_heavy_research_credentials_and_real_retriever_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "light-key")
    monkeypatch.setenv("OPENAI_API_KEY_HEAVY", "heavy-key")
    monkeypatch.setenv("RETRIEVER", "tavily")
    probe = AsyncMock(return_value={"name": "model_probe", "ok": True, "message": "ready"})
    monkeypatch.setattr(preflight_module, "_probe_model_directory", probe)
    result = await preflight_module.research_preflight(ConfiguredAdapter())
    assert {call.args[0].api_key for call in probe.await_args_list} == {"light-key", "heavy-key"}
    assert any(check["name"] == "retriever" and check.get("level") == "warning" for check in result["checks"])
