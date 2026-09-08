"""Provider-neutral text generation for Anthropic and OpenAI-compatible APIs."""

from __future__ import annotations

import asyncio
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Literal

from openai.types.chat import ChatCompletionMessageParam

from ai_engine.llm.config import (
    LlmPurpose,
    fallback_spec as configured_fallback_spec,
    parse_spec,
    resolve_route,
)
from ai_engine.llm.usage_audit import LlmUsageAttempt, record_llm_usage

LlmTier = Literal["light", "heavy"]
_SECRET_RE = re.compile(r"(?:sk|key|token)[-_][A-Za-z0-9._-]{8,}", re.IGNORECASE)
_client_cache: dict[tuple[asyncio.AbstractEventLoop, type[Any], str, str, str], Any] = {}
_loop_semaphores: dict[
    tuple[asyncio.AbstractEventLoop, int],
    asyncio.Semaphore,
] = {}
_circuit_failures: dict[str, tuple[int, float]] = {}
_circuit_lock = asyncio.Lock()


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
    purpose: LlmPurpose = "research" if tier == "heavy" else "utility"
    # Keep the vendor-qualified spec for the provider-neutral client.  The
    # wire protocol is a separate concern: MiniMax/DeepSeek both speak the
    # OpenAI protocol, but must retain their vendor identity for credentials,
    # endpoint selection, audit, and fallback routing.
    return resolve_route(purpose, spec=explicit, tier=tier).spec


def _parse_spec(spec: str) -> tuple[str, str]:
    vendor, model = parse_spec(spec)
    if vendor not in {"anthropic", "openai", "minimax", "deepseek"}:
        raise ValueError(
            f"unsupported LLM provider {vendor!r}; expected "
            "anthropic, openai, minimax, or deepseek"
        )
    return vendor, model


def _credential_profile(model: str) -> str | None:
    """Select an optional model-specific credential profile.

    The provider prefix describes the wire protocol (``anthropic`` or
    ``openai``).  A model-specific profile allows two compatible providers
    to coexist without overwriting the generic credentials, e.g. MiniMax as
    the primary and DeepSeek as the fallback.
    """
    normalized = model.strip().lower()
    if normalized.startswith("minimax-") or normalized.startswith("minimax:"):
        return "MINIMAX"
    if normalized.startswith("deepseek-") or normalized.startswith("deepseek:"):
        return "DEEPSEEK"
    return None


def _profile_value(profile: str, name: str) -> str:
    return (
        os.environ.get(f"{profile}_{name}", "")
        or os.environ.get(f"{profile.lower()}_{name.lower()}", "")
    )


def _credentials(provider: str, tier: LlmTier, model: str = "") -> tuple[str, str | None]:
    purpose: LlmPurpose = "research" if tier == "heavy" else "utility"
    route = resolve_route(purpose, spec=f"{provider}:{model}", tier=tier)
    key = route.api_key
    if not key or key.startswith("local-"):
        key = f"sk-placeholder-for-{route.vendor}-compatible-proxy"
    return key, route.base_url


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
        # Retries belong to this layer so we can audit and order them before
        # fallback.  The SDK's hidden retries otherwise blur attempt_count.
        client = client_type(api_key=api_key, base_url=base_url)
        if hasattr(client, "max_retries"):
            client.max_retries = 0
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


def is_retryable_llm_error(exc: BaseException) -> bool:
    """Whether a configured fallback model may recover this provider failure."""
    # The provider SDK can surface a dropped streaming/socket write as a
    # built-in transport exception rather than an HTTP error. It is safe to
    # retry these boundedly; classifying them as INTERNAL makes long research
    # jobs fail after collecting useful evidence instead of trying the
    # configured fallback or returning a retryable service-unavailable state.
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return True
    if is_quota_error(exc):
        return True
    if getattr(exc, "status_code", None) in {408, 409, 500, 502, 503, 504}:
        return True
    detail = f"{type(exc).__name__}: {exc}".lower()
    return any(
        marker in detail
        for marker in (
            "apiconnectionerror",
            "apitimeouterror",
            "connecterror",
            "connection error",
            "internalservererror",
            "proxy_error",
            "upstream request failed",
            "client error (connect)",
            "service unavailable",
            "gateway timeout",
        )
    )


def _fallback_spec(primary_spec: str) -> str | None:
    candidate = configured_fallback_spec()
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
    """Generate text with explicit retry -> fallback ordering.

    ``LLM_RETRY_ATTEMPTS`` is the number of retries for each model (default 1).
    Non-retryable configuration/authentication errors go straight to the
    caller; deterministic degradation remains a business-level decision.
    """
    primary_spec = _llm_spec(tier, llm_spec)
    fallback_spec = _fallback_spec(primary_spec)
    retry_count = max(0, int(os.environ.get("LLM_RETRY_ATTEMPTS", "1")))
    routes = [primary_spec]
    if fallback_spec:
        routes.append(fallback_spec)
    last_error: BaseException | None = None
    total_attempts = 0

    for route_index, route_spec in enumerate(routes):
        used_fallback = route_index > 0
        purpose: LlmPurpose = "research" if tier == "heavy" else "utility"
        route = resolve_route(
            purpose,
            spec=route_spec,
            tier=tier,
        )
        if await _circuit_is_open(route.endpoint_key):
            last_error = RuntimeError(f"LLM endpoint circuit open: {route.endpoint_key}")
            continue
        for retry_index in range(retry_count + 1):
            total_attempts += 1
            started_at = time.monotonic()
            try:
                result = await _generate_text_once(
                    llm_spec=route_spec,
                    user_prompt=user_prompt,
                    system_prompt=system_prompt,
                    tier=tier,
                    max_tokens=max_tokens,
                    timeout=timeout,
                    disable_thinking=disable_thinking,
                )
            except Exception as error:
                last_error = error
                retryable = is_retryable_llm_error(error)
                circuit_state = await _circuit_failure(
                    route.endpoint_key,
                    retryable=retryable,
                )
                await _record_failure(
                    operation=operation,
                    request_id=request_id,
                    llm_spec=route_spec,
                    fallback_spec=fallback_spec,
                    used_fallback=used_fallback,
                    error=error,
                    started_at=started_at,
                    primary_model=primary_spec,
                    fallback_reason=(
                        _fallback_reason(error) if used_fallback else None
                    ),
                    attempt_count=total_attempts,
                    endpoint=route.base_url,
                    circuit_state=circuit_state,
                )
                if not retryable:
                    raise
                continue
            await _circuit_success(route.endpoint_key)
            await _record_success(
                operation=operation,
                request_id=request_id,
                result=result,
                fallback_spec=fallback_spec,
                used_fallback=used_fallback,
                started_at=started_at,
                primary_model=primary_spec,
                fallback_reason=(
                    _fallback_reason(last_error) if used_fallback and last_error else None
                ),
                attempt_count=total_attempts,
                endpoint=route.base_url,
                circuit_state="closed",
            )
            return result

    if last_error is not None:
        raise last_error
    raise RuntimeError("no usable LLM route configured")


def _fallback_reason(error: BaseException) -> str:
    if is_quota_error(error):
        return "quota_or_rate_limit"
    if getattr(error, "status_code", None) in {500, 502, 503, 504}:
        return "provider_5xx"
    return "connection_or_timeout"


async def _circuit_is_open(endpoint: str) -> bool:
    if os.environ.get("LLM_CIRCUIT_ENABLED", "true").lower() == "false":
        return False
    threshold = max(1, int(os.environ.get("LLM_CIRCUIT_FAILURE_THRESHOLD", "3")))
    cooldown = max(1, int(os.environ.get("LLM_CIRCUIT_COOLDOWN_SECONDS", "45")))
    async with _circuit_lock:
        failures, opened_at = _circuit_failures.get(endpoint, (0, 0.0))
        if failures < threshold:
            return False
        if time.monotonic() - opened_at < cooldown:
            return True
        # Half-open: allow one probe and count subsequent failures afresh.
        _circuit_failures[endpoint] = (0, 0.0)
        return False


async def _circuit_failure(endpoint: str, *, retryable: bool) -> str:
    if os.environ.get("LLM_CIRCUIT_ENABLED", "true").lower() == "false":
        return "disabled"
    threshold = max(1, int(os.environ.get("LLM_CIRCUIT_FAILURE_THRESHOLD", "3")))
    async with _circuit_lock:
        failures, opened_at = _circuit_failures.get(endpoint, (0, 0.0))
        if retryable:
            failures += 1
        state = "open" if failures >= threshold else "closed"
        _circuit_failures[endpoint] = (
            failures,
            time.monotonic() if state == "open" else opened_at,
        )
        return state


async def _circuit_success(endpoint: str) -> None:
    async with _circuit_lock:
        _circuit_failures.pop(endpoint, None)


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
    purpose: LlmPurpose = "research" if tier == "heavy" else "utility"
    route = resolve_route(purpose, spec=llm_spec, tier=tier)
    provider = route.vendor
    model = route.model
    api_key = route.api_key
    if not api_key or api_key.startswith("local-"):
        api_key = f"sk-placeholder-for-{provider}-compatible-proxy"
    base_url = route.base_url
    wire_provider = route.protocol

    if wire_provider == "anthropic":
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
    primary_model: str,
    fallback_reason: str | None,
    attempt_count: int,
    endpoint: str | None,
    circuit_state: str,
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
            primary_model=primary_model,
            fallback_reason=fallback_reason,
            attempt_count=attempt_count,
            final_model=result.requested_model,
            endpoint=endpoint,
            circuit_state=circuit_state,
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
    primary_model: str,
    fallback_reason: str | None,
    attempt_count: int,
    endpoint: str | None,
    circuit_state: str,
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
            primary_model=primary_model,
            fallback_reason=fallback_reason,
            attempt_count=attempt_count,
            final_model=None,
            endpoint=endpoint,
            circuit_state=circuit_state,
        )
    )
