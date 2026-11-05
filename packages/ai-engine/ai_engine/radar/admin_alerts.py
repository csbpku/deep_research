"""Optional operator alerts for radar sync problems (Feishu/Lark or generic JSON webhook).

Off unless ``ADMIN_ALERT_WEBHOOK_URL`` is set. Alerting is best-effort: it never
raises, never blocks the caller for longer than the timeout, and never changes
a sync result. Each alert key is sent at most once per dedup window, so a
failing source does not flood the channel on every tick.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

import httpx

from ai_engine.llm.client import _SECRET_RE

logger = logging.getLogger(__name__)

_TIMEOUT_SECONDS = 5.0
_MAX_TEXT_CHARS = 3000
_DEFAULT_DEDUP_MINUTES = 60.0
_FEISHU_HOST_MARKERS = ("feishu.cn", "larksuite.com")

_last_sent: dict[str, float] = {}
_lock: asyncio.Lock | None = None
_pending: set[asyncio.Task[bool]] = set()


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


def _webhook_url() -> str:
    return (os.environ.get("ADMIN_ALERT_WEBHOOK_URL") or "").strip()


def _dedup_seconds() -> float:
    raw = os.environ.get("ADMIN_ALERT_DEDUP_MINUTES", "").strip()
    try:
        minutes = float(raw) if raw else _DEFAULT_DEDUP_MINUTES
    except ValueError:
        minutes = _DEFAULT_DEDUP_MINUTES
    return max(0.0, minutes) * 60.0


def _is_feishu(url: str, configured: str) -> bool:
    if configured == "feishu":
        return True
    if configured == "generic":
        return False
    host = (urlsplit(url).hostname or "").lower()
    return any(host == marker or host.endswith("." + marker) for marker in _FEISHU_HOST_MARKERS)


def _safe_host(url: str) -> str:
    try:
        return urlsplit(url).hostname or "unknown"
    except ValueError:
        return "unparseable"


def _render_text(key: str, title: str, lines: list[str], severity: str) -> str:
    body = "\n".join(lines)
    text = f"[deep_research][{severity}] {title}\n{key}\n{body}".strip()
    text = _SECRET_RE.sub("[redacted]", text)
    if len(text) > _MAX_TEXT_CHARS:
        text = text[: _MAX_TEXT_CHARS - 1] + "…"
    return text


def _feishu_payload(text: str, secret: str) -> dict[str, Any]:
    payload: dict[str, Any] = {"msg_type": "text", "content": {"text": text}}
    if secret:
        timestamp = str(int(time.time()))
        string_to_sign = f"{timestamp}\n{secret}"
        digest = hmac.new(string_to_sign.encode("utf-8"), b"", digestmod=hashlib.sha256).digest()
        payload["timestamp"] = timestamp
        payload["sign"] = base64.b64encode(digest).decode("ascii")
    return payload


def _generic_payload(key: str, title: str, lines: list[str], severity: str) -> dict[str, Any]:
    return {
        "source": "deep_research.ai-engine",
        "key": key,
        "severity": severity,
        "title": title,
        "lines": [_SECRET_RE.sub("[redacted]", line)[:500] for line in lines][:20],
        "at": datetime.now(timezone.utc).isoformat(),
    }


def _feishu_accepted(response: httpx.Response) -> bool:
    if response.status_code != 200:
        return False
    try:
        body = response.json()
    except ValueError:
        return False
    if not isinstance(body, dict):
        return False
    code = body.get("code", body.get("StatusCode", 0))
    return code in (0, None, "0")


async def _send(
    key: str,
    title: str,
    lines: list[str],
    severity: str,
    *,
    client: httpx.AsyncClient | None,
) -> bool:
    url = _webhook_url()
    if not url:
        return False
    parts = urlsplit(url)
    if parts.scheme.lower() != "https" or not parts.hostname:
        logger.warning("ai-engine.admin_alert.disabled reason=url_not_https")
        return False
    configured_format = (os.environ.get("ADMIN_ALERT_WEBHOOK_FORMAT") or "").strip().lower()
    feishu = _is_feishu(url, configured_format)
    text = _render_text(key, title, lines, severity)
    if feishu:
        payload = _feishu_payload(text, (os.environ.get("ADMIN_ALERT_FEISHU_SECRET") or "").strip())
    else:
        payload = _generic_payload(key, title, lines, severity)

    owned = client is None
    http = client or httpx.AsyncClient(timeout=_TIMEOUT_SECONDS)
    try:
        response = await http.post(url, json=payload, timeout=_TIMEOUT_SECONDS)
        accepted = _feishu_accepted(response) if feishu else 200 <= response.status_code < 300
        if not accepted:
            logger.warning(
                "ai-engine.admin_alert.rejected host=%s status=%s", _safe_host(url), response.status_code,
            )
        return accepted
    except Exception as exc:  # never let alerting affect the caller
        logger.warning(
            "ai-engine.admin_alert.failed host=%s error_type=%s", _safe_host(url), type(exc).__name__,
        )
        return False
    finally:
        if owned:
            await http.aclose()


async def send_admin_alert(
    key: str,
    title: str,
    lines: list[str],
    *,
    severity: str = "warning",
    client: httpx.AsyncClient | None = None,
) -> bool:
    """Send one alert unless the same key was sent within the dedup window."""
    try:
        if not _webhook_url():
            return False
        window = _dedup_seconds()
        async with _get_lock():
            now = time.monotonic()
            last = _last_sent.get(key)
            if window > 0 and last is not None and now - last < window:
                return False
            _last_sent[key] = now
        sent = await _send(key, title, lines, severity, client=client)
        if not sent:
            # Allow a retry on the next occurrence instead of suppressing a
            # message that never reached the channel.
            async with _get_lock():
                if _last_sent.get(key) == now:
                    _last_sent.pop(key, None)
        return sent
    except Exception as exc:
        logger.warning("ai-engine.admin_alert.failed error_type=%s", type(exc).__name__)
        return False


def emit_admin_alert(
    key: str,
    title: str,
    lines: list[str],
    *,
    severity: str = "warning",
) -> asyncio.Task[bool] | None:
    """Fire-and-forget variant for synchronous sync paths. Keeps a task reference."""
    if not _webhook_url():
        return None
    task = asyncio.create_task(send_admin_alert(key, title, lines, severity=severity))
    _pending.add(task)
    task.add_done_callback(_pending.discard)
    return task


def reset_admin_alerts_for_tests() -> None:
    _last_sent.clear()
