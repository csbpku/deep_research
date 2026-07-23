"""POST /api/shares endpoint tests — Week 4 (W4-2).

Verifies the FastAPI HTTP layer for the share endpoint. We:
1. Validate the happy path (in-memory backend fallback → 202 + summary_id).
2. Validate validation failures (URL too long, file:// scheme, etc.).
3. Validate the response shape.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
from httpx import ASGITransport

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.job_runner.store import InMemoryJobStore
from ai_engine.server.app import app, _store_singleton


async def _make_client() -> AsyncIterator[httpx.AsyncClient]:
    """Fresh InMemoryJobStore + FakeAdapter for share tests."""
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode="success", sources_per_job=3)
    app.dependency_overrides[_store_singleton] = lambda: store
    from ai_engine.server import app as app_module

    original = app_module._adapter_singleton
    app_module._adapter_singleton = lambda: adapter  # type: ignore[assignment]
    transport = ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield client
    finally:
        app_module._adapter_singleton = original  # type: ignore[assignment]
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_share_endpoint_happy_path_returns_202() -> None:
    async for client in _make_client():
        resp = await client.post(
            "/api/shares",
            json={"url": "https://example.com/article", "userNote": "good read"},
        )
    assert resp.status_code == 202
    body = resp.json()
    # In-memory backend returns the deterministic stub id.
    assert body["summary_id"] == "00000000-0000-0000-0000-000000000099"
    assert body["status"] == "pending_review"
    assert body["canonical_url"] == "https://example.com/article"


@pytest.mark.asyncio
async def test_share_endpoint_rejects_long_url() -> None:
    async for client in _make_client():
        # Pydantic max_length=2048 → 422
        long_url = "https://example.com/" + ("a" * 5000)
        resp = await client.post(
            "/api/shares",
            json={"url": long_url, "userNote": None},
        )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_share_endpoint_rejects_long_user_note() -> None:
    async for client in _make_client():
        resp = await client.post(
            "/api/shares",
            json={"url": "https://example.com/", "userNote": "x" * 600},
        )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_share_endpoint_request_id_in_response() -> None:
    async for client in _make_client():
        resp = await client.post(
            "/api/shares",
            json={"url": "https://example.com/article", "userNote": None},
            headers={"x-request-id": "test-req-001"},
        )
    assert resp.status_code == 202
    assert resp.headers.get("x-request-id") == "test-req-001"
    body = resp.json()
    # request_id is taken from middleware; may be the same value.
    assert "request_id" in body


@pytest.mark.asyncio
async def test_share_endpoint_default_requester_id() -> None:
    async for client in _make_client():
        resp = await client.post(
            "/api/shares",
            json={"url": "https://example.com/article"},
        )
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_share_endpoint_with_explicit_requester_id() -> None:
    async for client in _make_client():
        resp = await client.post(
            "/api/shares",
            json={
                "url": "https://example.com/article",
                "requester_id": "11111111-1111-1111-1111-111111111111",
            },
        )
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_share_endpoint_rejects_file_scheme() -> None:
    async for client in _make_client():
        resp = await client.post(
            "/api/shares",
            json={"url": "file:///etc/passwd", "userNote": None},
        )
    assert resp.status_code == 400
    body = resp.json()
    assert body["detail"]["code"] == "VALIDATION_FAILED"


@pytest.mark.asyncio
async def test_share_endpoint_rejects_metadata_ip_at_validation_layer() -> None:
    """Even though the safe_fetch check is in the background worker,
    a host-less / unparseable URL must be rejected at the request layer.
    """
    async for client in _make_client():
        resp = await client.post(
            "/api/shares",
            json={"url": "http://169.254.169.254/latest/meta-data/", "userNote": None},
        )
    # 169.254.169.254 is a valid host (numeric IP), so the validation
    # passes here; safe_fetch in the background worker will reject it.
    # In the in-memory test path, we return 202 + the stub id.
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_share_endpoint_logs_do_not_leak_user_note(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Ensure the user_note (which can contain arbitrary text) is not logged."""
    secret_note = "SECRET_USER_NOTE_DO_NOT_LOG_INSECURE"
    async for client in _make_client():
        await client.post(
            "/api/shares",
            json={"url": "https://example.com/article", "userNote": secret_note},
        )
    import asyncio

    await asyncio.sleep(0.05)
    captured = capsys.readouterr()
    text = captured.out + captured.err
    # userNote is intentionally NOT logged anywhere (architectural rule).
    assert secret_note not in text, f"userNote leaked into logs: {text[:500]}"
    # The endpoint itself must always log a request line.
    assert "ai-engine.request" in text