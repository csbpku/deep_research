from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

import ai_engine.radar.sync_endpoint as endpoint
from ai_engine.radar import admin_alerts
from ai_engine.radar.admin_alerts import reset_admin_alerts_for_tests, send_admin_alert

FEISHU_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/secret-token-value"
GENERIC_URL = "https://alerts.example.com/hook/abc"


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch: pytest.MonkeyPatch) -> None:
    reset_admin_alerts_for_tests()
    for name in (
        "ADMIN_ALERT_WEBHOOK_URL",
        "ADMIN_ALERT_WEBHOOK_FORMAT",
        "ADMIN_ALERT_FEISHU_SECRET",
        "ADMIN_ALERT_DEDUP_MINUTES",
    ):
        monkeypatch.delenv(name, raising=False)


def _client(
    bodies: list[dict[str, Any]],
    *,
    status: int = 200,
    reply: dict[str, Any] | None = None,
) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(status, json=reply if reply is not None else {"code": 0, "msg": "success"})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_disabled_when_no_webhook_is_configured() -> None:
    bodies: list[dict[str, Any]] = []
    assert await send_admin_alert("k", "t", ["line"], client=_client(bodies)) is False
    assert bodies == []


async def test_feishu_text_payload_is_sent_for_feishu_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", FEISHU_URL)
    bodies: list[dict[str, Any]] = []
    sent = await send_admin_alert("radar.sources_failed", "多数来源失败", ["失败 3/4"], client=_client(bodies))
    assert sent is True
    assert bodies[0]["msg_type"] == "text"
    assert "多数来源失败" in bodies[0]["content"]["text"]
    assert "timestamp" not in bodies[0] and "sign" not in bodies[0]


async def test_feishu_signature_is_added_when_secret_is_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", FEISHU_URL)
    monkeypatch.setenv("ADMIN_ALERT_FEISHU_SECRET", "signing-secret")
    bodies: list[dict[str, Any]] = []
    assert await send_admin_alert("k", "t", ["x"], client=_client(bodies)) is True
    body = bodies[0]
    expected = base64.b64encode(
        hmac.new(f"{body['timestamp']}\nsigning-secret".encode(), b"", hashlib.sha256).digest()
    ).decode()
    assert body["sign"] == expected


async def test_generic_payload_for_other_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", GENERIC_URL)
    bodies: list[dict[str, Any]] = []
    sent = await send_admin_alert(
        "radar.auto_paused:rss", "暂停", ["a"], severity="critical", client=_client(bodies),
    )
    assert sent is True
    body = bodies[0]
    assert body["source"] == "deep_research.ai-engine"
    assert body["key"] == "radar.auto_paused:rss"
    assert body["severity"] == "critical"
    assert body["lines"] == ["a"]
    assert "msg_type" not in body


async def test_same_key_is_suppressed_within_the_dedup_window(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", GENERIC_URL)
    bodies: list[dict[str, Any]] = []
    client = _client(bodies)
    assert await send_admin_alert("same", "t", ["1"], client=client) is True
    assert await send_admin_alert("same", "t", ["2"], client=client) is False
    assert await send_admin_alert("other", "t", ["3"], client=client) is True
    assert len(bodies) == 2


async def test_failed_delivery_is_retried_on_next_occurrence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", GENERIC_URL)
    bodies: list[dict[str, Any]] = []
    assert await send_admin_alert("k", "t", ["1"], client=_client(bodies, status=500)) is False
    assert await send_admin_alert("k", "t", ["2"], client=_client(bodies)) is True
    assert len(bodies) == 2


async def test_feishu_business_error_counts_as_not_delivered(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", FEISHU_URL)
    bodies: list[dict[str, Any]] = []
    sent = await send_admin_alert("k", "t", ["1"], client=_client(bodies, reply={"code": 19024, "msg": "bad sign"}))
    assert sent is False


async def test_transport_errors_never_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", GENERIC_URL)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await send_admin_alert("k", "t", ["1"], client=client) is False


async def test_non_https_webhook_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", "http://alerts.example.com/hook")
    bodies: list[dict[str, Any]] = []
    assert await send_admin_alert("k", "t", ["1"], client=_client(bodies)) is False
    assert bodies == []


async def test_logs_never_contain_the_webhook_token(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", FEISHU_URL)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom " + str(request.url))

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with caplog.at_level("DEBUG"):
        assert await send_admin_alert("k", "t", ["1"], client=client) is False
    assert "secret-token-value" not in caplog.text


@pytest.mark.parametrize("status", [200, 503])
async def test_webhook_response_logs_hide_credentials_without_hiding_other_requests(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, status: int,
) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", FEISHU_URL)
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json={"code": 0}))
    async with httpx.AsyncClient(transport=transport) as client:
        with caplog.at_level("DEBUG"):
            assert await send_admin_alert("k", "t", ["1"], client=client) is (status == 200)
            # The private-request context must be reset even after a rejection.
            await client.get("https://status.example.com/public-diagnostics")
    assert "secret-token-value" not in caplog.text
    assert "public-diagnostics" in caplog.text
    if status == 503:
        assert "admin_alert.rejected" in caplog.text


async def test_alert_log_privacy_does_not_suppress_concurrent_http_requests(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", FEISHU_URL)
    sending = asyncio.Event()
    finish = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            sending.set()
            await finish.wait()
        return httpx.Response(200, json={"code": 0})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with caplog.at_level("DEBUG"):
            alert = asyncio.create_task(send_admin_alert("k", "t", ["1"], client=client))
            try:
                await asyncio.wait_for(sending.wait(), timeout=1)
                await client.get("https://status.example.com/concurrent-diagnostics")
            finally:
                finish.set()
                sent = await alert
    assert sent is True
    assert "secret-token-value" not in caplog.text
    assert "concurrent-diagnostics" in caplog.text


async def test_rendered_text_redacts_credentials_and_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", FEISHU_URL)
    bodies: list[dict[str, Any]] = []
    await send_admin_alert("k", "t", ["token sk-abcdefghijklmnop", "x" * 10_000], client=_client(bodies))
    text = bodies[0]["content"]["text"]
    assert "sk-abcdefghijklmnop" not in text
    assert len(text) <= admin_alerts._MAX_TEXT_CHARS


async def test_dedup_window_zero_sends_every_time(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_ALERT_WEBHOOK_URL", GENERIC_URL)
    monkeypatch.setenv("ADMIN_ALERT_DEDUP_MINUTES", "0")
    bodies: list[dict[str, Any]] = []
    client = _client(bodies)
    assert await send_admin_alert("k", "t", ["1"], client=client) is True
    assert await send_admin_alert("k", "t", ["2"], client=client) is True
    assert len(bodies) == 2


def test_run_alert_rules_cover_failed_sources_quota_and_scoring(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fake_emit(key: str, title: str, lines: list[str], **kwargs: Any) -> None:
        calls.append(key)

    monkeypatch.setattr(endpoint, "emit_admin_alert", fake_emit)

    def run(source_id: str, status: str) -> SimpleNamespace:
        return SimpleNamespace(source_id=source_id, status=status)

    pipeline = SimpleNamespace(
        sync=SimpleNamespace(runs=(run("a", "failed"), run("b", "failed"), run("c", "completed"))),
        quota_stopped=True,
        enrichment_error=None,
    )
    endpoint._emit_run_alerts(
        pipeline, ["default_rate 20.0% > 15% threshold"], batch_id="batch-1", triggered_by="cron",
    )

    assert "radar.sources_failed" in calls  # 2 of 3 latest runs failed
    assert "radar.model_quota_stopped" in calls
    assert "radar.scoring:default_rate" in calls
    assert "radar.enrichment_failed" not in calls


def test_latest_retry_run_replaces_the_earlier_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(endpoint, "emit_admin_alert", lambda key, *a, **k: calls.append(key))

    def run(source_id: str, status: str) -> SimpleNamespace:
        return SimpleNamespace(source_id=source_id, status=status)

    # The first attempt failed, the retry recovered: nothing to alert about.
    pipeline = SimpleNamespace(
        sync=SimpleNamespace(runs=(run("a", "failed"), run("a", "completed"))),
        quota_stopped=False,
        enrichment_error=None,
    )
    endpoint._emit_run_alerts(pipeline, [], batch_id="b", triggered_by="cron")
    assert calls == []
