"""Bounded, cached readiness checks; never generate billable model output."""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
from datetime import datetime, timezone
from typing import NotRequired, TypedDict
from urllib.parse import urlsplit

import httpx

from ai_engine.adapters.base import ResearchEngineAdapter
from ai_engine.llm.config import LlmRoute, resolve_route


class PreflightCheck(TypedDict):
    name: str
    ok: bool
    message: str
    level: NotRequired[str]


class PreflightPayload(TypedDict):
    ok: bool
    checks: list[PreflightCheck]
    checkedAt: str


_cache: dict[str, tuple[float, PreflightPayload]] = {}
_pending: dict[str, asyncio.Task[PreflightPayload]] = {}
_CACHE_SECONDS = 60.0
_FORCE_COOLDOWN_SECONDS = 5.0


async def _probe_model_directory(route: LlmRoute) -> PreflightCheck:
    """Use provider metadata rather than a completion for a readiness probe."""
    name = f"model_probe:{route.vendor}:{route.model}"
    base_url = route.base_url or (
        "https://api.anthropic.com/v1" if route.protocol == "anthropic" else "https://api.openai.com/v1"
    )
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return {"name": name, "ok": False, "message": "模型服务地址无效"}
    headers = (
        {"x-api-key": route.api_key, "anthropic-version": "2023-06-01"}
        if route.protocol == "anthropic"
        else {"authorization": f"Bearer {route.api_key}"}
    )
    try:
        async with asyncio.timeout(3.0), httpx.AsyncClient(timeout=3.0, follow_redirects=False) as client:
            # Streaming bounds memory even if a misconfigured gateway returns
            # a large response. No response body or provider error is exposed.
            async with client.stream("GET", f"{base_url.rstrip('/')}/models", headers=headers) as response:
                code = response.status_code
    except (httpx.HTTPError, ValueError, TimeoutError):
        return {"name": name, "ok": True, "level": "warning", "message": "模型连通性尚未确认，请求超时或网络不可达"}
    if code in {401, 403}:
        return {"name": name, "ok": False, "message": "模型服务拒绝凭据，请检查密钥或订阅权限"}
    if code == 429:
        return {"name": name, "ok": False, "message": "模型服务当前限流或额度不足，请稍后重试"}
    if 200 <= code < 300:
        return {"name": name, "ok": True, "message": "模型服务可达，凭据已通过目录接口认证"}
    return {"name": name, "ok": True, "level": "warning", "message": f"模型服务未提供可用的目录检查（HTTP {code}），连通性尚未确认"}


async def _build_preflight(adapter: ResearchEngineAdapter, routes: list[LlmRoute]) -> PreflightPayload:
    checks: list[PreflightCheck] = []
    try:
        health = await asyncio.wait_for(adapter.health(), timeout=1.0)
        checks.append({"name": "adapter", "ok": health.ok, "message": f"研究引擎：{health.adapter_name}"})
    except Exception:
        checks.append({"name": "adapter", "ok": False, "message": "研究引擎尚未就绪"})

    if adapter.name != "fake":
        probes: dict[tuple[str, str, str], LlmRoute] = {}
        for slot, route in zip(("research_llm", "utility_llm"), routes):
            checks.append({
                "name": slot,
                "ok": bool(route.api_key),
                "message": f"{slot}：{route.spec}" if route.api_key else f"{slot} 缺少模型服务凭据",
            })
            if route.api_key:
                probes[(route.protocol, route.base_url or "", route.api_key)] = route
        checks.extend(await asyncio.gather(*(_probe_model_directory(route) for route in probes.values())))
        retriever = os.environ.get("RETRIEVER", "").strip().lower()
        has_tavily_key = bool(os.environ.get("TAVILY_API_KEY", "").strip())
        if retriever == "tavily" and not has_tavily_key:
            checks.append({"name": "retriever", "ok": True, "level": "warning", "message": "Tavily 未配置凭据，将使用 DuckDuckGo 检索"})
        else:
            selected = retriever or ("tavily" if has_tavily_key else "duckduckgo")
            checks.append({"name": "retriever", "ok": True, "message": f"检索配置：{selected}"})
    return {"ok": all(check["ok"] for check in checks), "checks": checks, "checkedAt": datetime.now(timezone.utc).isoformat()}


async def research_preflight(adapter: ResearchEngineAdapter, *, force: bool = False) -> PreflightPayload:
    try:
        routes = [] if adapter.name == "fake" else [
            resolve_route("research", tier="heavy"), resolve_route("utility", tier="light"),
        ]
    except ValueError:
        return {
            "ok": False,
            "checks": [{"name": "llm_config", "ok": False, "message": "模型槽位配置无效，请检查 provider:model 与协议"}],
            "checkedAt": datetime.now(timezone.utc).isoformat(),
        }
    # Never keep plaintext credentials in cache keys; rotation invalidates the
    # cache. Deduplicate in-flight requests and bound repeated manual refreshes.
    config = repr((adapter.name, routes, [route.api_key for route in routes],
                   os.environ.get("RETRIEVER"), bool(os.environ.get("TAVILY_API_KEY"))))
    key = hashlib.sha256(config.encode()).hexdigest()
    cached = _cache.get(key)
    ttl = _FORCE_COOLDOWN_SECONDS if force else _CACHE_SECONDS
    if cached and time.monotonic() - cached[0] < ttl:
        return cached[1]
    if key in _pending:
        return await asyncio.shield(_pending[key])

    async def run() -> PreflightPayload:
        try:
            result = await _build_preflight(adapter, routes)
            if len(_cache) >= 64:
                _cache.clear()
            _cache[key] = (time.monotonic(), result)
            return result
        finally:
            _pending.pop(key, None)

    task = asyncio.create_task(run())
    _pending[key] = task
    return await asyncio.shield(task)
