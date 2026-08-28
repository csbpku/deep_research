from __future__ import annotations

from typing import Any

import pytest

from ai_engine.server.chat import _anythingllm_chat_enabled, _anythingllm_usage


def _configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANYTHINGLLM_URL", "http://localhost:3002")
    monkeypatch.setenv("ANYTHINGLLM_API_KEY", "test-key")
    monkeypatch.setenv("ANYTHINGLLM_WORKSPACE", "my-workspace")
    monkeypatch.setenv("ANYTHINGLLM_ENABLED", "true")


def test_anythingllm_allowlist_is_opt_in(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)
    monkeypatch.setenv("ANYTHINGLLM_RADAR_IDS", "radar-1")

    assert _anythingllm_chat_enabled({"id": "radar-1"}) is True
    assert _anythingllm_chat_enabled({"id": "radar-2"}) is False


def test_anythingllm_empty_allowlist_enables_all_configured_radars(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configured(monkeypatch)
    monkeypatch.setenv("ANYTHINGLLM_RADAR_IDS", "")

    assert _anythingllm_chat_enabled({"id": "radar-1"}) is True
    assert _anythingllm_chat_enabled({"id": "radar-2"}) is True


def test_anythingllm_usage_accepts_openai_style_fields() -> None:
    payload: dict[str, Any] = {
        "model": "test-model",
        "usage": {"prompt_tokens": 12, "completion_tokens": 5},
    }

    assert _anythingllm_usage(payload) == (12, 5, "test-model")


def test_anythingllm_usage_accepts_metrics_shape() -> None:
    payload: dict[str, Any] = {
        "type": "textResponse",
        "textResponse": "OK",
        "metrics": {
            "prompt_tokens": 154,
            "completion_tokens": 29,
            "model": "deepseek-v4-flash",
        },
    }

    assert _anythingllm_usage(payload) == (154, 29, "deepseek-v4-flash")
