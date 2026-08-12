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
from ai_engine.fetcher import ai_source_urls
from ai_engine.fetcher.ai_source_urls import (
    FetchedUrlSource,
    _canonical_key,
    _fetch_user_url,
    _looks_like_arxiv,
    _strip_query_for_log,
)
from ai_engine.fetcher.safe_fetch import SafeFetchError
from ai_engine.radar.models import RadarCandidate


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


# P1.7: arxiv URL detection + dispatch to radar arxiv_fetcher.
import asyncio as _asyncio


def test_looks_like_arxiv_matches_canonical_and_pdf_urls() -> None:
    from ai_engine.fetcher.ai_source_urls import _looks_like_arxiv

    assert _looks_like_arxiv("https://arxiv.org/abs/2608.10720")
    assert _looks_like_arxiv("https://arxiv.org/pdf/2608.10720")
    assert _looks_like_arxiv("https://export.arxiv.org/abs/2608.10720")
    assert not _looks_like_arxiv("https://example.com/abs/2608.10720")
    assert not _looks_like_arxiv("https://anthropic.com/news")
    assert not _looks_like_arxiv("not a url")


async def test_arxiv_url_dispatches_to_radar_fetcher(monkeypatch: pytest.MonkeyPatch) -> None:
    """An arxiv URL should reach the radar arxiv fetcher and surface a title."""
    from ai_engine.fetcher import ai_source_urls

    captured: dict[str, Any] = {}

    async def fake_arxiv_candidates(config: Any) -> list[Any]:
        captured["config"] = config
        candidate = RadarCandidate(
            title="SWE-agent benchmark",
            url="https://arxiv.org/abs/2608.10720",
            snippet="Comprehensive SWE-agent benchmark paper.",
            published_at=None,
            content_origin="api",
            tags=("arxiv",),
        )
        return [candidate]

    # Patch the source of the import, since the function imports it lazily.
    import ai_engine.radar.arxiv_fetcher as _arxiv_mod

    monkeypatch.setattr(_arxiv_mod, "fetch_arxiv_candidates", fake_arxiv_candidates)

    result = await ai_source_urls._fetch_user_url(
        {"type": "url", "value": "https://arxiv.org/abs/2608.10720"}
    )
    assert result.is_accessible is True
    assert result.adapter_source.title == "SWE-agent benchmark"
    assert captured["config"] == {"maxResults": 5, "categories": [], "lookback_days": 365}


async def test_arxiv_url_without_match_returns_ARXIV_NO_MATCH(monkeypatch: pytest.MonkeyPatch) -> None:
    import ai_engine.radar.arxiv_fetcher as _arxiv_mod

    async def fake_empty(config: Any) -> list[Any]:
        return []

    monkeypatch.setattr(_arxiv_mod, "fetch_arxiv_candidates", fake_empty)

    result = await ai_source_urls._fetch_user_url(
        {"type": "url", "value": "https://arxiv.org/abs/0000.00000"}
    )
    assert result.is_accessible is False
    assert result.error_code == "ARXIV_NO_MATCH"


async def test_non_arxiv_url_skips_radar_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    """A non-arxiv URL must NOT enter the radar arxiv fetcher."""
    import ai_engine.radar.arxiv_fetcher as _arxiv_mod

    called = {"n": 0}

    async def fake_arxiv_candidates(config: Any) -> list[Any]:
        called["n"] += 1
        return []

    monkeypatch.setattr(_arxiv_mod, "fetch_arxiv_candidates", fake_arxiv_candidates)
    try:
        try:
            await ai_source_urls._fetch_user_url(
                {"type": "url", "value": "https://example.com/post"}
            )
        except Exception:
            # safe_fetch may raise in sandboxed environments; the assertion
            # we care about is that the arxiv dispatch was NOT triggered.
            pass
        assert called["n"] == 0
    finally:
        pass