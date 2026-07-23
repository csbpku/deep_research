"""AI sourceRefs[type='url'] helper tests — Week 4 (W4-3).

Three required tests per W4 brief:
1. happy path — public URL returns an AdapterSource with is_accessible=True
2. unsafe URL (private/loopback IP) returns is_accessible=False +
   error_code=URL_FETCH_BLOCKED
3. invalid source_ref shape (missing value / wrong scheme) raises
   AdapterError(VALIDATION_FAILED).

Plus a few additional safety checks (canonical_key, no-query logging,
404 handling).
"""

from __future__ import annotations

from typing import Callable

import httpx
import pytest

from ai_engine.adapters.base import AdapterSource
from ai_engine.contracts.errors import AdapterError
from ai_engine.fetcher.ai_source_urls import (
    FetchedUrlSource,
    _canonical_key,
    _fetch_user_url,
    _strip_query_for_log,
)
from ai_engine.fetcher.safe_fetch import SafeFetchError


# ---------------------------------------------------------------------------
# Re-use the same MockTransport pattern as test_safe_fetch
# ---------------------------------------------------------------------------


class _MockTransport(httpx.AsyncBaseTransport):
    def __init__(self, routes: dict[str, Callable[[httpx.Request], httpx.Response]]) -> None:
        self._routes = routes

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host or ""
        handler = self._routes.get(host)
        if handler is None:
            return httpx.Response(599, text=f"no route for host {host}")
        result = handler(request)
        if hasattr(result, "__await__"):
            result = await result
        return result


def _client(transport: httpx.AsyncBaseTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=transport)


def _ok(body: bytes, content_type: str = "text/html") -> httpx.Response:
    return httpx.Response(
        200, content=body, headers={"content-type": content_type},
        request=httpx.Request("GET", "http://placeholder/"),
    )


@pytest.fixture
def patch_resolver(monkeypatch: pytest.MonkeyPatch) -> Callable[[str, str], None]:
    """Install a stub resolver that ai_source_urls + safe_fetch share."""
    import ai_engine.fetcher.safe_fetch as sf

    table: dict[str, str] = {}

    def _resolve(host: str) -> str:
        if host in table:
            return table[host]
        import socket

        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        if not infos:
            raise SafeFetchError(
                code="URL_FETCH_BLOCKED",
                message=f"DNS resolution failed for host {host}",
                host=host,
            )
        return str(infos[0][4][0])

    monkeypatch.setattr(sf, "_resolve_ip", _resolve)
    return table.__setitem__


# ---------------------------------------------------------------------------
# Required 3-case matrix
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ai_source_01_happy_path(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """Public URL → AdapterSource with is_accessible=True."""
    patch_resolver("ok.example", "8.8.8.8")
    body = b"<html><head><title>Hello</title></head><body>world</body></html>"

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, request=request)

    transport = _MockTransport({"ok.example": handler})
    client = _client(transport)

    # Inject the client into safe_fetch via the module's namespace.
    import ai_engine.fetcher.safe_fetch as sf

    # Patch `safe_fetch` to use our client. Simpler: monkey-patch httpx.
    orig_client_factory = sf.httpx.AsyncClient

    def factory(*args, **kwargs):  # type: ignore[no-untyped-def]
        # Always return our mock client.
        return client

    sf.httpx.AsyncClient = factory  # type: ignore[assignment]
    try:
        result = await _fetch_user_url(
            {"type": "url", "value": "https://ok.example/article"}
        )
    finally:
        sf.httpx.AsyncClient = orig_client_factory  # type: ignore[assignment]

    assert isinstance(result, FetchedUrlSource)
    assert result.is_accessible is True
    assert result.error_code is None
    assert isinstance(result.adapter_source, AdapterSource)
    assert result.adapter_source.title == "Hello"
    assert result.adapter_source.is_accessible is True
    assert result.adapter_source.canonical_key.startswith("https://ok.example")


@pytest.mark.asyncio
async def test_ai_source_02_private_url_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """Private IP URL → is_accessible=False + error_code=URL_FETCH_BLOCKED."""
    patch_resolver("private.example", "10.0.0.5")
    transport = _MockTransport({"private.example": lambda r: _ok(b"x")})
    client = _client(transport)

    import ai_engine.fetcher.safe_fetch as sf

    orig_client_factory = sf.httpx.AsyncClient

    def factory(*args, **kwargs):  # type: ignore[no-untyped-def]
        return client

    sf.httpx.AsyncClient = factory  # type: ignore[assignment]
    try:
        result = await _fetch_user_url(
            {"type": "url", "value": "http://private.example/"}
        )
    finally:
        sf.httpx.AsyncClient = orig_client_factory  # type: ignore[assignment]

    assert result.is_accessible is False
    assert result.error_code == "URL_FETCH_BLOCKED"


@pytest.mark.asyncio
async def test_ai_source_03_invalid_ref_shape_rejected() -> None:
    """Missing `value` / wrong scheme → AdapterError(VALIDATION_FAILED)."""
    with pytest.raises(AdapterError) as exc_info:
        await _fetch_user_url({"type": "url", "value": ""})
    assert exc_info.value.code == "VALIDATION_FAILED"

    with pytest.raises(AdapterError) as exc_info2:
        await _fetch_user_url({"type": "url", "value": "ftp://example.com/x"})
    assert exc_info2.value.code == "VALIDATION_FAILED"


# ---------------------------------------------------------------------------
# Additional coverage: canonical_key, log redaction, 4xx response
# ---------------------------------------------------------------------------


def test_canonical_key_strips_tracking_query() -> None:
    out = _canonical_key("https://example.com/article?utm_source=x&page=2")
    assert "utm_source" not in out
    assert "page=2" in out


def test_canonical_key_lowercases_host() -> None:
    out = _canonical_key("HTTPS://Example.COM/Path")
    assert out.startswith("https://example.com/")


def test_strip_query_for_log_returns_no_query() -> None:
    out = _strip_query_for_log("https://example.com/article?secret=value")
    assert "?" not in out
    assert "secret" not in out


@pytest.mark.asyncio
async def test_ai_source_404_response_is_inaccessible(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """4xx response: is_accessible=False but no error_code (we got a doc)."""
    patch_resolver("missing.example", "8.8.8.8")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, request=request)

    transport = _MockTransport({"missing.example": handler})
    client = _client(transport)

    import ai_engine.fetcher.safe_fetch as sf

    orig_client_factory = sf.httpx.AsyncClient

    def factory(*args, **kwargs):  # type: ignore[no-untyped-def]
        return client

    sf.httpx.AsyncClient = factory  # type: ignore[assignment]
    try:
        result = await _fetch_user_url(
            {"type": "url", "value": "https://missing.example/x"}
        )
    finally:
        sf.httpx.AsyncClient = orig_client_factory  # type: ignore[assignment]

    assert result.is_accessible is False
    assert result.error_code is None  # 404 is not an error_code, just inaccessible
    assert result.adapter_source.is_accessible is False