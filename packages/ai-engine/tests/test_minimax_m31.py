"""Protect M3.1's mandatory-thinking contract across all reading transports."""

from types import SimpleNamespace

import pytest

from ai_engine.llm.client import (
    _generate_text_once,
    _generate_vision_once,
    _stream_text_once,
)
from ai_engine.llm.config import minimax_reasoning_effort, resolve_route


@pytest.mark.parametrize("path", ["text", "stream", "vision"])
async def test_m31_openai_requests_bound_effort_and_hide_reasoning(monkeypatch, path):
    captured = {}

    class Completions:
        async def create(self, **kwargs):
            captured.update(kwargs)
            if kwargs.get("stream"):
                async def chunks():
                    yield SimpleNamespace(choices=[SimpleNamespace(
                        delta=SimpleNamespace(content=None, reasoning_content="private"),
                        finish_reason=None,
                    )], usage=None)
                    yield SimpleNamespace(choices=[SimpleNamespace(
                        delta=SimpleNamespace(content="visible"), finish_reason="stop",
                    )], usage=None)
                return chunks()
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(
                    content="visible", reasoning_content="private",
                ), finish_reason="stop")],
                usage=None, model="MiniMax-M3.1-Flash",
            )

    class Client:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=Completions())

    monkeypatch.setattr("openai.AsyncOpenAI", Client)
    monkeypatch.setenv("MINIMAX_PROTOCOL", "openai")
    monkeypatch.setenv("MINIMAX_API_KEY", "fixture-key")
    monkeypatch.setenv("MINIMAX_BASE_URL", "https://models.example/v1")
    args = dict(llm_spec="minimax:MiniMax-M3.1-Flash", user_prompt="hello",
                system_prompt=None, max_tokens=128, timeout=10)
    emitted = []

    async def emit(value):
        emitted.append(value)

    if path == "text":
        result = await _generate_text_once(**args, tier="light", disable_thinking=True)
    elif path == "stream":
        result = await _stream_text_once(**args, tier="light", disable_thinking=True, emit=emit)
        assert "".join(emitted) == "visible"
    else:
        result = await _generate_vision_once(**args, image_media_type="image/png", image_base64="AQID")
    assert result.text == "visible"
    assert captured["model"] == "MiniMax-M3.1-Flash"
    assert captured["reasoning_effort"] == "low"
    assert captured["max_completion_tokens"] == 128
    assert "max_tokens" not in captured
    assert "extra_body" not in captured


async def test_m31_anthropic_uses_effort_instead_of_disabling_thinking(monkeypatch):
    captured = {}

    class Messages:
        async def create(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(content=[SimpleNamespace(type="text", text="visible")],
                                   usage=None, stop_reason="end_turn", model="MiniMax-M3.1-Flash")

    class Client:
        def __init__(self, **kwargs):
            self.messages = Messages()

    monkeypatch.setattr("anthropic.AsyncAnthropic", Client)
    monkeypatch.setenv("MINIMAX_PROTOCOL", "anthropic")
    monkeypatch.setenv("MINIMAX_API_KEY", "fixture-key")
    result = await _generate_text_once(
        llm_spec="minimax:MiniMax-M3.1-Flash", user_prompt="hello", system_prompt=None,
        tier="light", max_tokens=128, timeout=10, disable_thinking=True,
    )
    assert result.text == "visible"
    assert "thinking" not in captured
    assert captured["extra_body"] == {"output_config": {"effort": "low"}}


def test_m31_effort_follows_task_purpose():
    assert minimax_reasoning_effort("MiniMax-M3.1-Flash", tier="heavy") == "high"
    assert minimax_reasoning_effort("MiniMax-M3.1-Flash", tier="heavy", disable_thinking=True) == "low"
    assert minimax_reasoning_effort("MiniMax-M3") is None


def test_default_primary_models_are_m31(monkeypatch):
    for key in ("RESEARCH_LLM", "UTILITY_LLM", "PRIMARY_LLM", "SMART_LLM", "BRIEF_LLM"):
        monkeypatch.delenv(key, raising=False)
    assert resolve_route("research").model == "MiniMax-M3.1-Flash"
    assert resolve_route("utility").model == "MiniMax-M3.1-Flash"


async def test_gpt_researcher_passes_m31_research_effort(monkeypatch):
    from ai_engine.adapters import gpt_researcher as adapter

    captured = {}

    class Provider:
        async def get_chat_response(self, *args, **kwargs):
            return "research result"

    def get_llm(provider, **kwargs):
        captured.update(kwargs)
        return Provider()

    monkeypatch.setattr(adapter._llm_mod, "get_llm", get_llm)
    monkeypatch.setattr(adapter._llm_mod, "SUPPORT_REASONING_EFFORT_MODELS", ["MiniMax-M3.1-Flash"])
    result = await adapter._llm_mod.create_chat_completion(
        messages=[{"role": "user", "content": "test"}],
        model="MiniMax-M3.1-Flash", llm_provider="openai",
    )
    assert result == "research result"
    assert captured["reasoning_effort"] == "high"
