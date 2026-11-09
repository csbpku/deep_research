"""Share an exhausted provider allowance across workers without paid probes."""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from ai_engine.llm.config import LlmRoute


class ProviderQuotaExhausted(RuntimeError):
    def __init__(self, error: BaseException, retry_after_seconds: float) -> None:
        super().__init__(f"provider allowance exhausted; retry after {int(retry_after_seconds)} seconds")
        self.retry_after_seconds = retry_after_seconds
        self.__cause__ = error


@dataclass(frozen=True)
class _Cooldown:
    expires_at: float
    error: BaseException
    refresh_at: float


_cooldowns: dict[tuple[str, str], _Cooldown] = {}
_lock = asyncio.Lock()


def _key(route: LlmRoute) -> tuple[str, str]:
    # Different light/heavy credentials may have different allowances. Never
    # keep a credential in a loggable key or let one account block another.
    return route.endpoint_key, hashlib.sha256(route.api_key.encode()).hexdigest()


async def active_quota_error(route: LlmRoute) -> ProviderQuotaExhausted | None:
    refresh: _Cooldown | None = None
    async with _lock:
        state = _cooldowns.get(_key(route))
        if state is None:
            return None
        remaining = state.expires_at - time.monotonic()
        if remaining <= 0:
            _cooldowns.pop(_key(route), None)
            return None
        if state.refresh_at <= time.monotonic():
            refresh = _Cooldown(state.expires_at, state.error, time.monotonic() + 300)
            _cooldowns[_key(route)] = refresh
    if refresh is not None:
        # A top-up/upgrade can restore the same key before the window ends.
        # Recheck via the free status API, never via a paid generation probe.
        delay = await _minimax_reset_delay(route)
        async with _lock:
            if _cooldowns.get(_key(route)) is refresh:
                if delay == 0:
                    _cooldowns.pop(_key(route), None)
                    return None
                if delay is not None:
                    state = _Cooldown(time.monotonic() + delay + 1, state.error, refresh.refresh_at)
                    _cooldowns[_key(route)] = state
    return ProviderQuotaExhausted(state.error, max(0, state.expires_at - time.monotonic()))


def _reset_delay(payload: Any, now: float) -> float | None:
    if not isinstance(payload, dict):
        return None
    base = payload.get("base_resp")
    if isinstance(base, dict) and base.get("status_code") not in {None, 0}:
        return None
    rows = payload.get("model_remains")
    if not isinstance(rows, list):
        return None
    delays: list[float] = []
    percentages: list[float] = []
    for row in rows:
        if not isinstance(row, dict) or row.get("model_name") != "general":
            continue
        for percent, end in (
            ("current_interval_remaining_percent", "end_time"),
            ("current_weekly_remaining_percent", "weekly_end_time"),
        ):
            remaining, end_ms = row.get(percent), row.get(end)
            if (isinstance(remaining, (int, float)) and not isinstance(remaining, bool)
                    and 0 <= remaining <= 100):
                percentages.append(remaining)
            if (isinstance(remaining, (int, float)) and not isinstance(remaining, bool)
                    and remaining <= 0 and isinstance(end_ms, (int, float))):
                delay = end_ms / 1000 - now
                if 0 < delay <= 7 * 24 * 3600:
                    delays.append(delay)
    # Both windows must permit the request; resetting only the shorter one
    # does not replenish an exhausted weekly allowance.
    if len(percentages) == 2 and all(remaining > 0 for remaining in percentages):
        return 0.0
    return max(delays) if delays else None


async def _minimax_reset_delay(route: LlmRoute) -> float | None:
    if os.environ.get("LLM_QUOTA_STATUS_QUERY_ENABLED", "1").lower() in {"0", "false", "off", "no"}:
        return None
    if route.vendor != "minimax" or not route.api_key:
        return None
    if urlsplit(route.base_url or "").hostname not in {"api.minimaxi.com", "api.minimax.cn"}:
        return None
    try:
        # Official domestic quota endpoint. Do not forward a proxy/global key
        # to a guessed host or follow redirects with an Authorization header.
        async with httpx.AsyncClient(timeout=5, follow_redirects=False) as client:
            response = await client.get(
                "https://www.minimax.cn/v1/token_plan/remains",
                headers={"Authorization": f"Bearer {route.api_key}"},
            )
        if response.status_code == 200:
            return _reset_delay(response.json(), time.time())
    except (httpx.HTTPError, ValueError):
        pass
    return None


async def remember_quota_error(route: LlmRoute, error: BaseException) -> None:
    key = _key(route)
    fallback = max(60.0, float(os.environ.get("LLM_QUOTA_COOLDOWN_SECONDS", "3600")))
    async with _lock:
        old = _cooldowns.get(key)
        if old and old.expires_at > time.monotonic():
            return
        state = _Cooldown(time.monotonic() + fallback, error, time.monotonic() + 300)
        _cooldowns[key] = state
    # Publish the fallback cooldown first: concurrent failures neither keep
    # spending requests nor fan out identical quota-status GETs.
    delay = await _minimax_reset_delay(route)
    if delay is not None:
        async with _lock:
            if _cooldowns.get(key) is state:
                wait = delay + 1 if delay > 0 else 60
                _cooldowns[key] = _Cooldown(time.monotonic() + wait, error, time.monotonic() + 300)
