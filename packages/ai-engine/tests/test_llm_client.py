from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from ai_engine.llm.client import (
    ReasoningStreamFilter,
    TextGenerationResult,
    generate_vision,
    generate_text,
    is_provider_policy_error,
    is_retryable_llm_error,
    stream_text,
)
from ai_engine.llm.token_budget import TokenBudgetExceeded, TokenReservation


@pytest.fixture(autouse=True)
def isolate_llm_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests must not inherit the developer's real provider configuration."""
    for name in (
        "RESEARCH_LLM",
        "UTILITY_LLM",
        "FALLBACK_LLM",
        "MINIMAX_BASE_URL",
        "DEEPSEEK_BASE_URL",
    ):
        monkeypatch.delenv(name, raising=False)


async def test_direct_model_profile_uses_its_own_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class Completions:
        async def create(self, **kwargs: object) -> object:
            captured.update(kwargs)
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="ok"))],
                usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1),
                model="MiniMax-M3",
            )

    class Client:
        def __init__(self, **kwargs: object) -> None:
            captured["client"] = kwargs
            self.chat = SimpleNamespace(completions=Completions())

    monkeypatch.setattr("openai.AsyncOpenAI", Client)
    monkeypatch.setenv("minimax_api_key", "direct-minimax-key")
    monkeypatch.delenv("MINIMAX_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)

    result = await generate_text(
        llm_spec="minimax:MiniMax-M3",
        user_prompt="hello",
    )

    assert result.provider == "minimax"
    assert captured["client"] == {
        "api_key": "direct-minimax-key",
        "base_url": "https://api.minimaxi.com/v1",
    }


async def test_generate_reserves_before_provider_and_settles_reported_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[tuple[object, ...]] = []
    reservation = TokenReservation("11111111-1111-1111-1111-111111111111", 100)

    async def reserve(**kwargs: object) -> TokenReservation:
        events.append(("reserve", kwargs))
        return reservation

    async def settle(value: TokenReservation, actual: int) -> None:
        events.append(("settle", value.id, actual))

    async def provider(**_kwargs: object) -> TextGenerationResult:
        events.append(("provider",))
        return TextGenerationResult("ok", 12, 3, "test", "test", "openai")

    async def ignore_audit(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr("ai_engine.llm.client.reserve_llm_tokens", reserve)
    monkeypatch.setattr("ai_engine.llm.client.settle_llm_tokens", settle)
    monkeypatch.setattr("ai_engine.llm.client._generate_text_once", provider)
    monkeypatch.setattr("ai_engine.llm.client.record_llm_usage", ignore_audit)

    result = await generate_text(
        user_prompt="question",
        llm_spec="openai:test-model",
        max_tokens=40,
        budget_user_id="11111111-1111-1111-1111-111111111111",
    )

    assert result.text == "ok"
    assert [item[0] for item in events] == ["reserve", "provider", "settle"]
    assert events[-1] == ("settle", reservation.id, 15)


async def test_generate_does_not_call_provider_when_budget_is_exhausted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def reject(**_kwargs: object) -> None:
        raise TokenBudgetExceeded(scope="user", used=99, limit=100, requested=10)

    async def provider(**_kwargs: object) -> TextGenerationResult:
        raise AssertionError("provider must not be called after budget rejection")

    async def ignore_audit(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr("ai_engine.llm.client.reserve_llm_tokens", reject)
    monkeypatch.setattr("ai_engine.llm.client._generate_text_once", provider)
    monkeypatch.setattr("ai_engine.llm.client.record_llm_usage", ignore_audit)

    with pytest.raises(TokenBudgetExceeded):
        await generate_text(user_prompt="question", llm_spec="openai:test-model")


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


async def test_minimax_m3_disables_thinking_and_audits_truncation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    attempts: list[object] = []

    class Completions:
        async def create(self, **kwargs: object) -> object:
            captured.update(kwargs)
            return SimpleNamespace(
                choices=[SimpleNamespace(
                    message=SimpleNamespace(content='{"partial":'),
                    finish_reason="length",
                )],
                usage=SimpleNamespace(prompt_tokens=1800, completion_tokens=2048),
                model="MiniMax-M3",
            )

    class Client:
        def __init__(self, **kwargs: object) -> None:
            self.chat = SimpleNamespace(completions=Completions())

    async def capture_usage(attempt: object) -> None:
        attempts.append(attempt)

    monkeypatch.setattr("openai.AsyncOpenAI", Client)
    monkeypatch.setattr("ai_engine.llm.client.record_llm_usage", capture_usage)
    monkeypatch.setenv("MINIMAX_API_KEY", "test-key")

    result = await generate_text(
        llm_spec="minimax:MiniMax-M3",
        user_prompt="Return one JSON object.",
        max_tokens=2048,
        disable_thinking=True,
        operation="radar.distilled_score",
    )

    assert result.truncated is True
    assert captured["max_completion_tokens"] == 2048
    assert "max_tokens" not in captured
    assert captured["extra_body"] == {"thinking": {"type": "disabled"}}
    assert len(attempts) == 1
    assert attempts[0].status == "degraded"
    assert attempts[0].error_kind == "truncated_response"
    assert attempts[0].error_message == "finish_reason=length; output_tokens=2048"
    assert attempts[0].degraded is True


async def test_generate_vision_sends_browser_image_bytes_as_multimodal_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class Completions:
        async def create(self, **kwargs: object) -> object:
            captured.update(kwargs)
            return SimpleNamespace(
                choices=[SimpleNamespace(
                    message=SimpleNamespace(content='{"regions":[]}'),
                    finish_reason="stop",
                )],
                usage=SimpleNamespace(prompt_tokens=100, completion_tokens=12),
                model="minimax-vision-test",
            )

    class Client:
        def __init__(self, **kwargs: object) -> None:
            captured["client"] = kwargs
            self.chat = SimpleNamespace(completions=Completions())

    async def ignore_audit(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr("openai.AsyncOpenAI", Client)
    monkeypatch.setattr("ai_engine.llm.client.record_llm_usage", ignore_audit)
    monkeypatch.setenv("MINIMAX_API_KEY", "test-key")
    monkeypatch.setenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/v1")

    result = await generate_vision(
        llm_spec="minimax:MiniMax-VL-01",
        system_prompt="Translate image text.",
        user_prompt="Return JSON.",
        image_media_type="image/png",
        image_base64="AQID",
    )

    assert result.text == '{"regions":[]}'
    assert captured["messages"] == [
        {"role": "system", "content": "Translate image text."},
        {"role": "user", "content": [
            {"type": "text", "text": "Return JSON."},
            {"type": "image_url", "image_url": {
                "url": "data:image/png;base64,AQID",
                "detail": "high",
            }},
        ]},
    ]
    assert captured["model"] == "MiniMax-VL-01"


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


def test_transport_disconnects_are_retryable() -> None:
    assert is_retryable_llm_error(BrokenPipeError("upstream closed the pipe")) is True
    assert is_retryable_llm_error(ConnectionResetError("connection reset by peer")) is True


def test_only_known_provider_policy_422_is_retryable() -> None:
    class PolicyError(Exception):
        status_code = 422

    assert is_provider_policy_error(PolicyError("input new_sensitive (1026)")) is True
    assert is_retryable_llm_error(PolicyError("input new_sensitive (1026)")) is True
    assert is_provider_policy_error(PolicyError("invalid schema field")) is False
    assert is_retryable_llm_error(PolicyError("invalid schema field")) is False


def test_minimax_overload_529_is_retryable() -> None:
    class OverloadedError(Exception):
        status_code = 529

    assert is_retryable_llm_error(OverloadedError("overloaded_error")) is True


def test_reasoning_stream_filter_handles_split_tags() -> None:
    filt = ReasoningStreamFilter()
    visible = "".join(
        filt.feed(chunk)
        for chunk in ("<thi", "nk>private", " thoughts</thi", "nk>答案")
    ) + filt.finish()
    assert visible == "答案"


async def test_stream_text_uses_provider_stream_and_filters_reasoning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class Stream:
        def __init__(self) -> None:
            self._chunks = [
                SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="<thi"), finish_reason=None)],
                    usage=None,
                ),
                SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="nk>private</think>答"), finish_reason=None)],
                    usage=None,
                ),
                SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="案"), finish_reason="stop")],
                    usage=SimpleNamespace(prompt_tokens=8, completion_tokens=2),
                ),
            ]

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self._chunks:
                raise StopAsyncIteration
            return self._chunks.pop(0)

    class Completions:
        async def create(self, **kwargs: object) -> Stream:
            captured.update(kwargs)
            return Stream()

    class Client:
        def __init__(self, **kwargs: object) -> None:
            captured["client"] = kwargs
            self.chat = SimpleNamespace(completions=Completions())

    monkeypatch.setattr("openai.AsyncOpenAI", Client)
    monkeypatch.setenv("OPENAI_API_KEY", "local-test")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:8318/v1")
    deltas: list[str] = []

    async def collect(value: str) -> None:
        deltas.append(value)

    result = await stream_text(
        llm_spec="openai:test-stream-model",
        user_prompt="hello",
        on_delta=collect,
    )

    assert result.text == "答案"
    assert "".join(deltas) == "答案"
    assert captured["stream"] is True
    assert result.input_tokens == 8
    assert result.output_tokens == 2


async def test_minimax_stream_requests_usage_in_final_chunk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class Stream:
        def __init__(self) -> None:
            self._chunks = [
                SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="答复"), finish_reason="stop")],
                    usage=None,
                ),
                SimpleNamespace(
                    choices=[],
                    usage=SimpleNamespace(prompt_tokens=23, completion_tokens=7),
                ),
            ]

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self._chunks:
                raise StopAsyncIteration
            return self._chunks.pop(0)

    class Completions:
        async def create(self, **kwargs: object) -> Stream:
            captured.update(kwargs)
            return Stream()

    class Client:
        def __init__(self, **_kwargs: object) -> None:
            self.chat = SimpleNamespace(completions=Completions())

    monkeypatch.setattr("openai.AsyncOpenAI", Client)
    monkeypatch.setenv("MINIMAX_API_KEY", "test-key")
    monkeypatch.setenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/v1")

    result = await stream_text(
        llm_spec="minimax:MiniMax-M3",
        user_prompt="hello",
        on_delta=lambda _value: _ignore_delta(),
    )

    assert captured["stream_options"] == {"include_usage": True}
    assert result.text == "答复"
    assert (result.input_tokens, result.output_tokens) == (23, 7)


async def _ignore_delta() -> None:
    return None


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
    assert captured_models == [
        "MiniMax-M3",
        "MiniMax-M3",
        "deepseek-v4-flash",
    ]
    assert len(audit_events) == 3
    assert getattr(audit_events[0], "status") == "failed"
    assert getattr(audit_events[0], "error_kind") == "quota"
    assert getattr(audit_events[-1], "used_fallback") is True


async def test_generate_text_falls_back_after_provider_policy_422(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_models: list[str] = []
    audit_events: list[object] = []

    class PolicyError(Exception):
        status_code = 422

    class Messages:
        async def create(self, **kwargs: object) -> object:
            model = str(kwargs["model"])
            captured_models.append(model)
            if model == "MiniMax-M3":
                raise PolicyError("input new_sensitive (1026)")
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text="policy fallback ok")],
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
        operation="test.policy_fallback",
    )

    assert result.text == "policy fallback ok"
    assert captured_models == [
        "MiniMax-M3",
        "MiniMax-M3",
        "deepseek-v4-flash",
    ]
    assert getattr(audit_events[-1], "used_fallback") is True
    assert getattr(audit_events[-1], "fallback_reason") == "provider_policy_block"


async def test_generate_text_falls_back_after_provider_502(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_models: list[str] = []
    audit_events: list[object] = []

    class ProviderError(Exception):
        status_code = 502

    class Messages:
        async def create(self, **kwargs: object) -> object:
            model = str(kwargs["model"])
            captured_models.append(model)
            if model == "MiniMax-M3":
                raise ProviderError(
                    "proxy_error: upstream request failed: client error (Connect)"
                )
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
    )

    assert result.text == "fallback ok"
    assert result.requested_model == "deepseek-v4-flash"
    assert captured_models == [
        "MiniMax-M3",
        "MiniMax-M3",
        "deepseek-v4-flash",
    ]
    assert getattr(audit_events[-1], "used_fallback") is True


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


async def test_endpoint_circuit_opens_after_configured_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.llm import client

    client._circuit_failures.clear()
    monkeypatch.setenv("LLM_CIRCUIT_ENABLED", "true")
    monkeypatch.setenv("LLM_CIRCUIT_FAILURE_THRESHOLD", "1")
    monkeypatch.setenv("LLM_CIRCUIT_COOLDOWN_SECONDS", "60")

    state = await client._circuit_failure("https://primary.example/v1", retryable=True)

    assert state == "open"
    assert await client._circuit_is_open("https://primary.example/v1") is True
