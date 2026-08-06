"""Best-effort refresh bridge for a local WeWe RSS instance."""

from __future__ import annotations

from collections.abc import Mapping
import os
from typing import Any
from urllib.parse import urlsplit

import httpx
import structlog

log = structlog.get_logger(__name__)


def _record_diagnostic(config: Mapping[str, Any], code: str, message: str) -> None:
    try:
        config["_wewe_refresh_diagnostic"] = (code, message)  # type: ignore[index]
    except (TypeError, AttributeError):
        pass


def is_wewe_config(config: Mapping[str, Any]) -> bool:
    feed_url = str(config.get("feedUrl") or "").strip()
    parsed = urlsplit(feed_url)
    port = parsed.port or (80 if parsed.scheme == "http" else 443)
    return parsed.hostname in {"localhost", "127.0.0.1", "::1"} and port == 4001


async def refresh_wewe_articles(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> bool:
    """Refresh all WeWe feeds; a failure must not block RSS ingestion."""
    if not is_wewe_config(config):
        return False
    parsed = urlsplit(str(config["feedUrl"]))
    endpoint = f"{parsed.scheme}://{parsed.netloc}/trpc/feed.refreshArticles?batch=1"
    payload: dict[str, Any] = {"0": {"json": {}}}
    mp_id = config.get("weweRefreshMpId")
    if mp_id:
        payload["0"]["json"] = {"mpId": str(mp_id)}
    headers = {"content-type": "application/json"}
    auth_code = (
        config.get("weweAuthCode")
        or config.get("authCode")
        or os.getenv("WEWE_AUTH_CODE")
        or os.getenv("WEWE_RSS_AUTH_CODE")
    )
    if auth_code:
        headers["Authorization"] = str(auth_code)
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=2.0))
    try:
        log.info("wewe.refresh_started", endpoint=endpoint)
        response = await http.post(endpoint, json=payload, headers=headers)
        try:
            body = response.json()
        except ValueError:
            body = None
        error_text = str(body) if body is not None else response.text[:500]
        if response.status_code == 401 or "authCode不正确" in error_text:
            _record_diagnostic(config, "WEWE_AUTH_CONFIG_INVALID", "WeWe auth code 无效")
            raise RuntimeError("WeWe auth code is invalid")
        if "暂无可用读书账号" in error_text or "登录失效" in error_text:
            _record_diagnostic(config, "UPSTREAM_AUTH_REQUIRED", "WeWe 读书账号登录已失效，需要重新扫码登录")
            raise RuntimeError("WeWe reading account is expired")
        if response.is_error:
            _record_diagnostic(config, "WEWE_REFRESH_FAILED", f"WeWe refresh HTTP {response.status_code}")
            response.raise_for_status()
        if isinstance(body, list) and body and isinstance(body[0], dict) and body[0].get("error"):
            _record_diagnostic(config, "WEWE_REFRESH_FAILED", "WeWe tRPC refresh returned an error")
            raise RuntimeError("WeWe tRPC returned an error")
        log.info("wewe.refresh_done", status=response.status_code)
        return True
    except Exception as exc:  # noqa: BLE001 - refresh must not block radar sync
        if "_wewe_refresh_diagnostic" not in config:
            _record_diagnostic(config, "WEWE_REFRESH_UNAVAILABLE", f"WeWe refresh failed: {exc}")
        log.warning("wewe.refresh_failed", error=str(exc), endpoint=endpoint)
        return False
    finally:
        if owns_client:
            await http.aclose()


__all__ = ["is_wewe_config", "refresh_wewe_articles"]
