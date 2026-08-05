"""Provider-neutral text generation for Anthropic and OpenAI-compatible APIs."""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from typing import Any, Literal

from openai.types.chat import ChatCompletionMessageParam

LlmTier = Literal["light", "heavy"]
_SECRET_RE = re.compile(r"(?:sk|key|token)[-_][A-Za-z0-9._-]{8,}", re.IGNORECASE)
_client_cache: dict[tuple[asyncio.AbstractEventLoop, type[Any], str, str, str], Any] = {}
_loop_semaphores: dict[
    tuple[asyncio.AbstractEventLoop, int],
    asyncio.Semaphore,
] = {}


@dataclass(slots=True, frozen=True)
class TextGenerationResult:
    text: str
    input_tokens: int
    output_tokens: int
    requested_model: str
    actual_model: str | None
    provider: str


def _llm_spec(tier: LlmTier, explicit: str | None) -> str:
    if explicit:
        return explicit
    if tier == "light":
        return (
            os.environ.get("BRIEF_LLM")
            or os.environ.get("SMART_LLM")
            or "anthropic:claude-haiku-4-5"
        )
    return os.environ.get("SMART_LLM") or "anthropic:claude-sonnet-4-6"


def _parse_spec(spec: str) -> tuple[str, str]:
    provider, separator, model = spec.partition(":")
    provider = provider.strip().lower()
    model = model.strip()
    if not separator or not provider or not model:
        raise ValueError(f"invalid LLM spec {spec!r}; expected provider:model")
    if provider not in {"anthropic", "openai"}:
        raise ValueError(
            f"unsupported LLM provider {provider!r}; expected anthropic or openai"
        )
    return provider, model


def _credentials(provider: str, tier: LlmTier) -> tuple[str, str | None]:
    prefix = provider.upper()
    light_key = os.environ.get(f"{prefix}_API_KEY", "")
    light_url = os.environ.get(f"{prefix}_BASE_URL")
    if tier == "heavy":
        key = os.environ.get(f"{prefix}_API_KEY_HEAVY", "") or light_key
        base_url = os.environ.get(f"{prefix}_BASE_URL_HEAVY") or light_url
    else:
        key = light_key or os.environ.get(f"{prefix}_API_KEY_HEAVY", "")
        base_url = light_url or os.environ.get(f"{prefix}_BASE_URL_HEAVY")

    if not key or key.startswith("local-"):
        key = f"sk-placeholder-for-{provider}-compatible-proxy"
    return key, base_url


def llm_is_configured(llm_spec: str | None = None, *, tier: LlmTier = "light") -> bool:
    """Return whether the selected provider has a key or explicit endpoint."""
    provider, _ = _parse_spec(_llm_spec(tier, llm_spec))
    prefix = provider.upper()
    if tier == "heavy":
        return bool(
            os.environ.get(f"{prefix}_API_KEY_HEAVY")
            or os.environ.get(f"{prefix}_BASE_URL_HEAVY")
            or os.environ.get(f"{prefix}_API_KEY")
            or os.environ.get(f"{prefix}_BASE_URL")
        )
    return bool(
        os.environ.get(f"{prefix}_API_KEY")
        or os.environ.get(f"{prefix}_BASE_URL")
        or os.environ.get(f"{prefix}_API_KEY_HEAVY")
        or os.environ.get(f"{prefix}_BASE_URL_HEAVY")
    )


def _llm_semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    concurrency = max(1, int(os.environ.get("RADAR_LLM_CONCURRENCY", "8")))
    key = (loop, concurrency)
    semaphore = _loop_semaphores.get(key)
    if semaphore is None:
        semaphore = asyncio.Semaphore(concurrency)
        _loop_semaphores[key] = semaphore
    return semaphore


def _cached_client(
    client_type: type[Any],
    *,
    provider: str,
    api_key: str,
    base_url: str | None,
) -> Any:
    loop = asyncio.get_running_loop()
    key = (loop, client_type, provider, api_key, base_url or "")
    client = _client_cache.get(key)
    if client is None:
        client = client_type(api_key=api_key, base_url=base_url)
        _client_cache[key] = client
    return client


def sanitize_llm_error(exc: BaseException) -> str:
    """Return a short provider error without leaking credentials."""
    text = _SECRET_RE.sub("[redacted]", str(exc))
    return f"{type(exc).__name__}: {text[:300]}"


async def generate_text(
    *,
    user_prompt: str,
    system_prompt: str | None = None,
    llm_spec: str | None = None,
    tier: LlmTier = "light",
    max_tokens: int = 1024,
    timeout: float = 60.0,
    disable_thinking: bool = False,
) -> TextGenerationResult:
    """Generate text through an Anthropic or OpenAI-compatible endpoint."""
    provider, model = _parse_spec(_llm_spec(tier, llm_spec))
    api_key, base_url = _credentials(provider, tier)

    if provider == "anthropic":
        from anthropic import AsyncAnthropic

        anthropic_client = _cached_client(
            AsyncAnthropic,
            provider=provider,
            api_key=api_key,
            base_url=base_url,
        )
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": user_prompt}],
            "timeout": timeout,
        }
        if system_prompt:
            kwargs["system"] = system_prompt
        if disable_thinking:
            kwargs["thinking"] = {"type": "disabled"}
        async with _llm_semaphore():
            message = await anthropic_client.messages.create(**kwargs)
        text = "".join(
            block.text
            for block in message.content
            if getattr(block, "type", None) == "text" and hasattr(block, "text")
        ).strip()
        usage = getattr(message, "usage", None)
        return TextGenerationResult(
            text=text,
            input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
            output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
            requested_model=model,
            actual_model=str(getattr(message, "model", "") or "") or None,
            provider=provider,
        )

    from openai import AsyncOpenAI

    openai_client = _cached_client(
        AsyncOpenAI,
        provider=provider,
        api_key=api_key,
        base_url=base_url,
    )
    messages: list[ChatCompletionMessageParam] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})
    async with _llm_semaphore():
        response = await openai_client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            timeout=timeout,
        )
    choice = response.choices[0] if response.choices else None
    content = choice.message.content if choice is not None else ""
    if isinstance(content, list):
        text = "".join(
            str(getattr(part, "text", "") or "")
            for part in content
        ).strip()
    else:
        text = str(content or "").strip()
    usage = getattr(response, "usage", None)
    return TextGenerationResult(
        text=text,
        input_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
        output_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
        requested_model=model,
        actual_model=str(getattr(response, "model", "") or "") or None,
        provider=provider,
    )
