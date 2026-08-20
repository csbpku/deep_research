from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from ai_engine.llm.client import generate_text


async def test_generate_text_uses_anthropic_compatible_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class Messages:
        async def create(self, **kwargs: object) -> object:
            captured.update(kwargs)
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text="anthropic ok")],
                usage=SimpleNamespace(input_tokens=11, output_tokens=4),
                model="MiniMax-M3",
            )

    class Client:
        def __init__(self, **kwargs: object) -> None:
            captured["client"] = kwargs
            self.messages = Messages()

    monkeypatch.setattr("anthropic.AsyncAnthropic", Client)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "local-cc-switch")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://localhost:15721")

    result = await generate_text(
        llm_spec="anthropic:deepseek-v4-flash",
        user_prompt="hello",
        disable_thinking=True,
    )

    assert result.text == "anthropic ok"
    assert result.actual_model == "MiniMax-M3"
    assert result.input_tokens == 11
    assert captured["thinking"] == {"type": "disabled"}
    assert captured["client"] == {
        "api_key": "sk-placeholder-for-anthropic-compatible-proxy",
        "base_url": "http://localhost:15721",
    }


async def test_generate_text_uses_openai_compatible_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class Completions:
        async def create(self, **kwargs: object) -> object:
            captured.update(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content="openai ok")
                    )
                ],
                usage=SimpleNamespace(prompt_tokens=9, completion_tokens=3),
                model="gpt-5.4-mini-2026-03-17",
            )

    class Client:
        def __init__(self, **kwargs: object) -> None:
            captured["client"] = kwargs
            self.chat = SimpleNamespace(completions=Completions())

    monkeypatch.setattr("openai.AsyncOpenAI", Client)
    monkeypatch.setenv("OPENAI_API_KEY", "local-vibeproxy")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:8318/v1")

    result = await generate_text(
        llm_spec="openai:gpt-5.4-mini",
        system_prompt="system",
        user_prompt="hello",
        max_tokens=64,
    )

    assert result.text == "openai ok"
    assert result.actual_model == "gpt-5.4-mini-2026-03-17"
    assert result.output_tokens == 3
    assert captured["messages"] == [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "hello"},
    ]
    assert captured["client"] == {
        "api_key": "sk-placeholder-for-openai-compatible-proxy",
        "base_url": "http://localhost:8318/v1",
    }


async def test_generate_text_rejects_unknown_provider() -> None:
    with pytest.raises(ValueError, match="unsupported LLM provider"):
        await generate_text(llm_spec="other:model", user_prompt="hello")


async def test_generate_text_reuses_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    constructed = 0

    class Completions:
        async def create(self, **kwargs: object) -> object:
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(message=SimpleNamespace(content="ok"))
                ],
                usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1),
                model="test-model",
            )

    class Client:
        def __init__(self, **kwargs: object) -> None:
            nonlocal constructed
            constructed += 1
            self.chat = SimpleNamespace(completions=Completions())

    monkeypatch.setattr("openai.AsyncOpenAI", Client)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:8318/v1")

    await generate_text(llm_spec="openai:test-model", user_prompt="one")
    await generate_text(llm_spec="openai:test-model", user_prompt="two")

    assert constructed == 1


async def test_generate_text_falls_back_after_quota_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_models: list[str] = []
    audit_events: list[object] = []

    class QuotaError(Exception):
        status_code = 429

    class Messages:
        async def create(self, **kwargs: object) -> object:
            model = str(kwargs["model"])
            captured_models.append(model)
            if model == "MiniMax-M3":
                raise QuotaError("quota exceeded")
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text="fallback ok")],
                usage=SimpleNamespace(input_tokens=7, output_tokens=3),
                model="deepseek-v4-flash",
                stop_reason="end_turn",
            )

    class Client:
        def __init__(self, **_: object) -> None:
            self.messages = Messages()

    async def record(event: object) -> None:
        audit_events.append(event)

    monkeypatch.setattr("anthropic.AsyncAnthropic", Client)
    monkeypatch.setattr("ai_engine.llm.client.record_llm_usage", record)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("LLM_FALLBACK_LLM", "anthropic:deepseek-v4-flash")

    result = await generate_text(
        llm_spec="anthropic:MiniMax-M3",
        user_prompt="hello",
        operation="test.fallback",
    )

    assert result.text == "fallback ok"
    assert captured_models == ["MiniMax-M3", "deepseek-v4-flash"]
    assert len(audit_events) == 2
    assert getattr(audit_events[0], "status") == "failed"
    assert getattr(audit_events[0], "error_kind") == "quota"
    assert getattr(audit_events[1], "used_fallback") is True


async def test_generate_text_limits_global_concurrency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    active = 0
    max_active = 0

    class Completions:
        async def create(self, **kwargs: object) -> object:
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await asyncio.sleep(0.02)
            active -= 1
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(message=SimpleNamespace(content="ok"))
                ],
                usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1),
                model="limited-model",
            )

    class Client:
        def __init__(self, **kwargs: object) -> None:
            self.chat = SimpleNamespace(completions=Completions())

    monkeypatch.setattr("openai.AsyncOpenAI", Client)
    monkeypatch.setenv("OPENAI_API_KEY", "limit-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:8318/v1")
    monkeypatch.setenv("RADAR_LLM_CONCURRENCY", "2")

    await asyncio.gather(*(
        generate_text(
            llm_spec="openai:limited-model",
            user_prompt=f"request-{index}",
        )
        for index in range(6)
    ))

    assert max_active == 2
