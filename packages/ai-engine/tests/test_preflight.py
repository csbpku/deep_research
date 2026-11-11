"""启动前预检：模型槽位、凭据与有界探测。

这些测试只覆盖 HTTP 层与配置解析，不访问真实 provider；`generate_text`
在探测相关用例中被 monkeypatch。
"""

from __future__ import annotations

import asyncio
import os

import httpx
import pytest

import ai_engine.server.app as server_app
from ai_engine.adapters.base import AdapterHealth
from ai_engine.server.app import app

_LLM_ENV = (
    "RESEARCH_LLM",
    "UTILITY_LLM",
    "FALLBACK_LLM",
    "LLM_FALLBACK_LLM",
    "PRIMARY_LLM",
    "SMART_LLM",
    "BRIEF_LLM",
    "RETRIEVER",
    "TAVILY_API_KEY",
)
for _profile in ("MINIMAX", "DEEPSEEK", "OPENAI", "ANTHROPIC"):
    _LLM_ENV += (
        f"{_profile}_API_KEY",
        f"{_profile}_API_KEY_HEAVY",
        f"{_profile}_BASE_URL",
        f"{_profile}_BASE_URL_HEAVY",
        f"{_profile}_PROTOCOL",
    )


@pytest.fixture(autouse=True)
def _clean_preflight_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _LLM_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(server_app, "_PREFLIGHT_CACHE", None)


def _headers() -> dict[str, str]:
    return {"x-internal-token": os.environ["INTERNAL_SERVICE_TOKEN"]}


async def _get_preflight(path: str = "/health/preflight") -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path, headers=_headers())


def _check(body: dict[str, object], name: str) -> dict[str, object]:
    checks = body["checks"]
    assert isinstance(checks, list)
    found = next(check for check in checks if check["name"] == name)
    assert isinstance(found, dict)
    return found


@pytest.mark.asyncio
async def test_preflight_blocks_when_model_key_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RESEARCH_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("UTILITY_LLM", "minimax:MiniMax-M3.1-Flash")

    response = await _get_preflight()

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    research = _check(body, "research_llm")
    assert research["ok"] is False
    assert "MINIMAX_API_KEY" in str(research["message"])


@pytest.mark.asyncio
async def test_preflight_passes_with_credentials_and_skips_probe_for_fake(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RESEARCH_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("UTILITY_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("MINIMAX_API_KEY", "test-minimax-key")

    response = await _get_preflight()

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert all(check["ok"] for check in body["checks"])
    probe = _check(body, "model_probe")
    assert probe["ok"] is True
    assert "跳过" in str(probe["message"])
    assert "minimax-key" not in response.text


@pytest.mark.asyncio
async def test_preflight_reports_invalid_slot_spec(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RESEARCH_LLM", "not-a-valid-spec")
    monkeypatch.setenv("UTILITY_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("MINIMAX_API_KEY", "test-minimax-key")

    response = await _get_preflight()

    body = response.json()
    assert body["ok"] is False
    research = _check(body, "research_llm")
    assert research["ok"] is False
    assert "RESEARCH_LLM" in str(research["message"])


class _StubAdapter:
    name = "gpt_researcher"

    async def health(self) -> AdapterHealth:
        return AdapterHealth(ok=True, adapter_name=self.name)


@pytest.mark.asyncio
async def test_preflight_probes_once_and_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RESEARCH_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("UTILITY_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("MINIMAX_API_KEY", "test-minimax-key")
    stub = _StubAdapter()
    monkeypatch.setattr(server_app, "_adapter_singleton", lambda: stub)
    calls: list[dict[str, object]] = []

    async def fake_generate_text(**kwargs: object) -> object:
        calls.append(kwargs)
        return object()

    monkeypatch.setattr(server_app, "generate_text", fake_generate_text)

    first = (await _get_preflight()).json()
    second = (await _get_preflight()).json()
    forced = (await _get_preflight("/health/preflight?force=true")).json()

    assert first["ok"] is True
    assert second["ok"] is True
    assert forced["ok"] is True
    assert len(calls) == 2
    assert calls[0]["single_attempt"] is True
    assert calls[0]["max_tokens"] == 8
    assert calls[0]["operation"] == "health.preflight"
    assert _check(first, "model_probe")["ok"] is True


@pytest.mark.asyncio
async def test_preflight_probe_timeout_is_warning_not_block(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RESEARCH_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("UTILITY_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("MINIMAX_API_KEY", "test-minimax-key")
    monkeypatch.setattr(server_app, "_adapter_singleton", lambda: _StubAdapter())
    monkeypatch.setattr(server_app, "_PREFLIGHT_PROBE_TIMEOUT_SECONDS", 0.05)

    async def slow_generate_text(**_: object) -> object:
        await asyncio.sleep(0.2)
        return object()

    monkeypatch.setattr(server_app, "generate_text", slow_generate_text)

    body = (await _get_preflight()).json()

    assert body["ok"] is True
    probe = _check(body, "model_probe")
    assert probe["ok"] is True
    assert probe["level"] == "warning"
    assert "超时" in str(probe["message"])


class _ProviderTimeout(Exception):
    """Mimics an SDK timeout exception (not a builtin TimeoutError)."""


@pytest.mark.asyncio
async def test_preflight_provider_timeout_is_warning_not_block(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RESEARCH_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("UTILITY_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("MINIMAX_API_KEY", "test-minimax-key")
    monkeypatch.setattr(server_app, "_adapter_singleton", lambda: _StubAdapter())

    async def timeout_generate_text(**_: object) -> object:
        raise _ProviderTimeout("Request timed out.")

    monkeypatch.setattr(server_app, "generate_text", timeout_generate_text)

    body = (await _get_preflight()).json()

    assert body["ok"] is True
    probe = _check(body, "model_probe")
    assert probe["level"] == "warning"
    assert "超时" in str(probe["message"])


@pytest.mark.asyncio
async def test_preflight_probe_failure_is_blocking_and_redacts_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RESEARCH_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("UTILITY_LLM", "minimax:MiniMax-M3.1-Flash")
    monkeypatch.setenv("MINIMAX_API_KEY", "test-minimax-key")
    monkeypatch.setattr(server_app, "_adapter_singleton", lambda: _StubAdapter())

    async def failing_generate_text(**_: object) -> object:
        raise RuntimeError("401 invalid api key sk-live-secret-value-12345")

    monkeypatch.setattr(server_app, "generate_text", failing_generate_text)

    response = await _get_preflight()
    body = response.json()

    assert body["ok"] is False
    probe = _check(body, "model_probe")
    assert probe["ok"] is False
    assert "sk-live-secret-value-12345" not in response.text
    assert "[redacted]" in str(probe["message"])


@pytest.mark.asyncio
async def test_preflight_requires_internal_token() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health/preflight")

    assert response.status_code == 403
    assert response.json()["code"] == "INTERNAL_TOKEN_MISMATCH"
