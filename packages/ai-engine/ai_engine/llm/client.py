"""Provider-neutral text generation for Anthropic and OpenAI-compatible APIs."""

from __future__ import annotations

import asyncio
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Literal

from openai.types.chat import ChatCompletionMessageParam

from ai_engine.llm.usage_audit import LlmUsageAttempt, record_llm_usage

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
    finish_reason: str | None = None
    truncated: bool = False


def _llm_spec(tier: LlmTier, explicit: str | None) -> str:
    if explicit:
        return explicit
    if tier == "light":
        return (
            os.environ.get("FAST_LLM")
            or os.environ.get("BRIEF_LLM")
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


def is_quota_error(exc: BaseException) -> bool:
    """Whether a provider rejected the call because its allowance is exhausted."""
    if getattr(exc, "status_code", None) == 429:
        return True
    detail = str(exc).lower()
    return any(
        marker in detail
        for marker in (
            "insufficient_quota",
            "quota exceeded",
            "usage limit",
            "rate limit",
            "rate_limit",
            "credit balance",
        )
    )


def _fallback_spec(primary_spec: str) -> str | None:
    candidate = os.environ.get("LLM_FALLBACK_LLM", "").strip()
    return candidate if candidate and candidate != primary_spec else None


async def generate_text(
    *,
    user_prompt: str,
    system_prompt: str | None = None,
    llm_spec: str | None = None,
    tier: LlmTier = "light",
    max_tokens: int = 1024,
    timeout: float = 60.0,
    disable_thinking: bool = False,
    operation: str = "llm.generate_text",
    request_id: str | None = None,
) -> TextGenerationResult:
    """Generate text, recording every attempt and falling back after quota errors."""
    primary_spec = _llm_spec(tier, llm_spec)
    fallback_spec = _fallback_spec(primary_spec)
    primary_started_at = time.monotonic()
    try:
        result = await _generate_text_once(
            llm_spec=primary_spec,
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            tier=tier,
            max_tokens=max_tokens,
            timeout=timeout,
            disable_thinking=disable_thinking,
        )
    except Exception as primary_error:
        await _record_failure(
            operation=operation,
            request_id=request_id,
            llm_spec=primary_spec,
            fallback_spec=fallback_spec,
            used_fallback=False,
            error=primary_error,
            started_at=primary_started_at,
        )
        if not fallback_spec or not is_quota_error(primary_error):
            raise
        fallback_started_at = time.monotonic()
        try:
            result = await _generate_text_once(
                llm_spec=fallback_spec,
                user_prompt=user_prompt,
                system_prompt=system_prompt,
                tier=tier,
                max_tokens=max_tokens,
                timeout=timeout,
                disable_thinking=disable_thinking,
            )
        except Exception as fallback_error:
            await _record_failure(
                operation=operation,
                request_id=request_id,
                llm_spec=fallback_spec,
                fallback_spec=None,
                used_fallback=True,
                error=fallback_error,
                started_at=fallback_started_at,
            )
            raise
        await _record_success(
            operation=operation,
            request_id=request_id,
            result=result,
            fallback_spec=primary_spec,
            used_fallback=True,
            started_at=fallback_started_at,
        )
        return result

    await _record_success(
        operation=operation,
        request_id=request_id,
        result=result,
        fallback_spec=fallback_spec,
        used_fallback=False,
        started_at=primary_started_at,
    )
    return result


async def _generate_text_once(
    *,
    llm_spec: str,
    user_prompt: str,
    system_prompt: str | None,
    tier: LlmTier,
    max_tokens: int,
    timeout: float,
    disable_thinking: bool,
) -> TextGenerationResult:
    provider, model = _parse_spec(llm_spec)
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
            finish_reason=str(getattr(message, "stop_reason", "") or "") or None,
            truncated=getattr(message, "stop_reason", None) == "max_tokens",
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
        finish_reason=str(getattr(choice, "finish_reason", "") or "") or None,
        truncated=getattr(choice, "finish_reason", None) in {"length", "max_tokens"},
    )


async def _record_success(
    *,
    operation: str,
    request_id: str | None,
    result: TextGenerationResult,
    fallback_spec: str | None,
    used_fallback: bool,
    started_at: float,
) -> None:
    await record_llm_usage(
        LlmUsageAttempt(
            operation=operation,
            request_id=request_id,
            provider=result.provider,
            requested_model=result.requested_model,
            actual_model=result.actual_model,
            fallback_model=fallback_spec,
            used_fallback=used_fallback,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            latency_ms=int((time.monotonic() - started_at) * 1000),
        )
    )


async def _record_failure(
    *,
    operation: str,
    request_id: str | None,
    llm_spec: str,
    fallback_spec: str | None,
    used_fallback: bool,
    error: BaseException,
    started_at: float,
) -> None:
    provider, model = _parse_spec(llm_spec)
    await record_llm_usage(
        LlmUsageAttempt(
            operation=operation,
            request_id=request_id,
            provider=provider,
            requested_model=model,
            fallback_model=fallback_spec,
            used_fallback=used_fallback,
            status="failed",
            error_kind="quota" if is_quota_error(error) else type(error).__name__,
            error_message=sanitize_llm_error(error),
            latency_ms=int((time.monotonic() - started_at) * 1000),
        )
    )
