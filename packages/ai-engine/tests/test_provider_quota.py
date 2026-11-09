from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

from ai_engine.llm.config import LlmRoute
from ai_engine.llm import provider_quota as quota


def route(key: str = "account-one", host: str = "https://api.minimaxi.com/v1") -> LlmRoute:
    return LlmRoute("minimax", "openai", "MiniMax-M3.1-Flash", host, key, "minimax:MiniMax-M3.1-Flash")


async def test_cooldown_is_shared_by_account_and_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [100.0]
    monkeypatch.setattr(quota, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setenv("LLM_QUOTA_COOLDOWN_SECONDS", "120")
    error = RuntimeError("Token Plan usage limit (2056)")
    await quota.remember_quota_error(route(), error)

    stopped = await quota.active_quota_error(route())
    assert stopped is not None and stopped.__cause__ is error
    assert stopped.retry_after_seconds == 120
    assert await quota.active_quota_error(route("account-two")) is None
    assert "account-one" not in str(quota._cooldowns)
    clock[0] += 121
    assert await quota.active_quota_error(route()) is None


def test_reset_time_uses_both_exhausted_windows_and_not_zero_legacy_counters() -> None:
    row = {
        "model_name": "general", "current_interval_total_count": 0,
        "current_interval_remaining_percent": 0, "end_time": 200_000,
        "current_weekly_remaining_percent": 89, "weekly_end_time": 500_000,
    }
    assert quota._reset_delay({"model_remains": [row]}, 100) == 100
    row["current_weekly_remaining_percent"] = 0
    assert quota._reset_delay({"model_remains": [row]}, 100) == 400
    assert quota._reset_delay({"model_remains": [row]}, 600) is None
    assert quota._reset_delay({"model_remains": [{"model_name": "video", **{}}]}, 100) is None
    row["current_interval_remaining_percent"] = 50
    row["current_weekly_remaining_percent"] = 80
    assert quota._reset_delay({"model_remains": [row]}, 100) == 0
    assert quota._reset_delay({"base_resp": {"status_code": 1004}, "model_remains": [row]}, 100) is None
    assert quota._reset_delay({"model_remains": [{
        "model_name": "general", "current_weekly_remaining_percent": 89,
    }]}, 100) is None


async def test_top_up_reopens_same_account_via_status_query_without_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [100.0]
    monkeypatch.setattr(quota, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    calls = 0

    async def status(_route: LlmRoute) -> float:
        nonlocal calls
        calls += 1
        return 1000 if calls == 1 else 0

    monkeypatch.setattr(quota, "_minimax_reset_delay", status)
    await quota.remember_quota_error(route(), RuntimeError("exhausted"))
    assert await quota.active_quota_error(route()) is not None
    clock[0] += 301
    assert await quota.active_quota_error(route()) is None
    assert calls == 2


async def test_only_official_domestic_endpoint_receives_quota_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []
    monkeypatch.setenv("LLM_QUOTA_STATUS_QUERY_ENABLED", "1")

    class Client:
        def __init__(self, **kwargs: object) -> None:
            assert kwargs["follow_redirects"] is False

        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_: object) -> None:
            pass

        async def get(self, url: str, *, headers: dict[str, str]) -> httpx.Response:
            seen.append(url)
            assert headers["Authorization"] == "Bearer account-one"
            return httpx.Response(200, json={"model_remains": [{
                "model_name": "general", "current_interval_remaining_percent": 0,
                "end_time": 200_000,
            }]})

    monkeypatch.setattr(quota.httpx, "AsyncClient", Client)
    monkeypatch.setattr(quota, "time", SimpleNamespace(time=lambda: 100))
    assert await quota._minimax_reset_delay(route()) == 100
    assert await quota._minimax_reset_delay(route(host="https://proxy.example/v1")) is None
    assert await quota._minimax_reset_delay(route(host="https://api.minimax.io/v1")) is None
    assert seen == ["https://www.minimax.cn/v1/token_plan/remains"]


async def test_concurrent_failures_query_allowance_once(monkeypatch: pytest.MonkeyPatch) -> None:
    started, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def reset_delay(_route: LlmRoute) -> float:
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return 500

    monkeypatch.setattr(quota, "_minimax_reset_delay", reset_delay)
    first = asyncio.create_task(quota.remember_quota_error(route(), RuntimeError("exhausted")))
    await started.wait()
    await quota.remember_quota_error(route(), RuntimeError("same quota"))
    assert await quota.active_quota_error(route()) is not None
    release.set()
    await first
    assert calls == 1
    state = await quota.active_quota_error(route())
    assert state is not None and 499 < state.retry_after_seconds <= 501
