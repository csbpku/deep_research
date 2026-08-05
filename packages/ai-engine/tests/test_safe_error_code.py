"""Tests for the per-exception error-code classification in
`ai_engine.radar.sync_runner._safe_error_code` and the
`ai_engine.ingestion.sources.fetch_arxiv` error mapping.

Background (S1 #7 — walkthrough regression): the original
``_safe_error_code`` collapsed every non-SafeFetch / non-Timeout /
non-ValueError exception into ``AI_ENGINE_UNAVAILABLE``, which masked
the actual root cause (e.g. arxiv rate-limit vs. DNS failure vs.
empty-response). These tests pin the new contract.
"""

from __future__ import annotations

import asyncio
import socket

import httpx
import pytest

from ai_engine.fetcher.safe_fetch import SafeFetchError
from ai_engine.radar.sync_runner import _safe_error_code


# ───────────── _safe_error_code ─────────────


def test_safe_error_code_passes_through_safe_fetch_codes() -> None:
    for code in (
        "URL_FETCH_BLOCKED",
        "URL_FETCH_DNS",
        "URL_FETCH_TIMEOUT",
        "URL_FETCH_TOO_LARGE",
        "URL_REDIRECT_LIMIT",
    ):
        assert _safe_error_code(SafeFetchError(code, "msg")) == code


def test_safe_error_code_maps_timeouts_to_worker_timeout() -> None:
    assert _safe_error_code(asyncio.TimeoutError()) == "WORKER_TIMEOUT"
    assert _safe_error_code(TimeoutError("sync wait")) == "WORKER_TIMEOUT"


def test_safe_error_code_maps_value_error_to_validation_failed() -> None:
    assert _safe_error_code(ValueError("bad cat")) == "VALIDATION_FAILED"


def test_safe_error_code_maps_dns_resolution_failure() -> None:
    assert _safe_error_code(socket.gaierror("dns")) == "URL_FETCH_DNS"


def test_safe_error_code_maps_httpx_timeout_to_url_fetch_timeout() -> None:
    # httpx.TimeoutException is a strict subclass of httpx.HTTPError,
    # so the order of isinstance checks matters. The fix must classify
    # it as a timeout, not a generic network error.
    assert _safe_error_code(httpx.ConnectTimeout("conn-timeout")) == "URL_FETCH_TIMEOUT"
    assert _safe_error_code(httpx.ReadTimeout("read-timeout")) == "URL_FETCH_TIMEOUT"


def test_safe_error_code_maps_network_to_url_fetch_blocked() -> None:
    assert _safe_error_code(httpx.ConnectError("dns")) == "URL_FETCH_BLOCKED"
    assert _safe_error_code(httpx.NetworkError("net")) == "URL_FETCH_BLOCKED"
    assert _safe_error_code(httpx.RemoteProtocolError("proto")) == "URL_FETCH_BLOCKED"


def test_safe_error_code_maps_arxiv_timeout_to_worker_timeout() -> None:
    # fetch_arxiv raises RuntimeError("arxiv_timeout:ConnectTimeout").
    # The classifier must surface it as WORKER_TIMEOUT so dashboards can
    # group it with the rest of the timeout family.
    assert _safe_error_code(RuntimeError("arxiv_timeout:ConnectTimeout")) == "WORKER_TIMEOUT"


def test_safe_error_code_maps_arxiv_rate_limited() -> None:
    assert _safe_error_code(RuntimeError("arxiv_rate_limited:429")) == "UPSTREAM_RATE_LIMITED"


def test_safe_error_code_maps_arxiv_network_to_blocked() -> None:
    assert _safe_error_code(RuntimeError("arxiv_network:ConnectError")) == "URL_FETCH_BLOCKED"


def test_safe_error_code_maps_arxiv_http_error_to_blocked() -> None:
    assert _safe_error_code(RuntimeError("arxiv_http_error:503")) == "URL_FETCH_BLOCKED"


def test_safe_error_code_maps_arxiv_parse_to_validation_failed() -> None:
    # arxiv returned a body that isn't valid Atom — most likely a
    # schema change on their side. Validation-classified.
    assert _safe_error_code(RuntimeError("arxiv_parse_failed:XMLSyntaxError")) == "VALIDATION_FAILED"
    assert _safe_error_code(RuntimeError("arxiv_empty_response")) == "VALIDATION_FAILED"


def test_safe_error_code_maps_arxiv_too_large() -> None:
    assert _safe_error_code(RuntimeError("arxiv_too_large:8388608")) == "URL_FETCH_TOO_LARGE"


def test_safe_error_code_falls_back_to_unavailable_for_unknown() -> None:
    class _WeirdError(Exception):
        pass

    assert _safe_error_code(_WeirdError("boom")) == "AI_ENGINE_UNAVAILABLE"
    # A RuntimeError that does not carry the arxiv_* prefix still falls back.
    assert _safe_error_code(RuntimeError("something else entirely")) == "AI_ENGINE_UNAVAILABLE"


# ───────────── fetch_arxiv User-Agent + error mapping ─────────────


class _StubTransport(httpx.AsyncBaseTransport):
    """httpx mock transport that returns a canned response and records
    the request headers (so we can assert the User-Agent was set)."""

    def __init__(self, response: httpx.Response) -> None:
        self._response = response
        self.last_request: httpx.Request | None = None

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.last_request = request
        return self._response


def _build_arxiv_xml(entries: list[tuple[str, str, str, str]]) -> bytes:
    """entries: list of (arxiv_id, title, summary, published)."""
    body_entries = "\n".join(
        f"<entry><id>http://arxiv.org/abs/{aid}v1</id>"
        f"<title>{title}</title><summary>{summary}</summary>"
        f"<published>{published}</published></entry>"
        for (aid, title, summary, published) in entries
    )
    return (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b"<feed xmlns=\"http://www.w3.org/2005/Atom\">"
        + body_entries.encode("utf-8")
        + b"</feed>"
    )


async def test_fetch_arxiv_sets_descriptive_user_agent() -> None:
    from ai_engine.ingestion.sources import fetch_arxiv

    body = _build_arxiv_xml([
        ("2501.00001", "Test paper", "An abstract", "2026-01-01T00:00:00Z"),
    ])
    response = httpx.Response(200, content=body, request=httpx.Request("GET", "https://x"))
    transport = _StubTransport(response)

    # Patch the AsyncClient used inside fetch_arxiv.
    async with httpx.AsyncClient(transport=transport) as _client:
        _ = _client  # keep ruff happy (the AsyncClient is only used as a transport)
        from ai_engine.ingestion import sources as sources_mod
        original = sources_mod.httpx.AsyncClient
        sources_mod.httpx.AsyncClient = lambda **kw: original(transport=transport, **kw)
        try:
            items = await fetch_arxiv(max_results=5, categories=["cs.AI"])
        finally:
            sources_mod.httpx.AsyncClient = original

    assert transport.last_request is not None
    ua = transport.last_request.headers.get("user-agent", "")
    assert "deep-research-ai-engine" in ua, f"expected descriptive UA, got {ua!r}"
    assert items, "expected at least one item from a valid Atom response"


async def test_fetch_arxiv_raises_typed_errors_on_rate_limit() -> None:
    from ai_engine.ingestion.sources import fetch_arxiv

    response = httpx.Response(
        429,
        headers={"retry-after": "60"},
        content=b"rate limit",
        request=httpx.Request("GET", "https://x"),
    )
    transport = _StubTransport(response)
    from ai_engine.ingestion import sources as sources_mod
    original = sources_mod.httpx.AsyncClient
    sources_mod.httpx.AsyncClient = lambda **kw: original(transport=transport, **kw)
    try:
        with pytest.raises(RuntimeError) as excinfo:
            await fetch_arxiv(max_results=5, categories=["cs.AI"])
    finally:
        sources_mod.httpx.AsyncClient = original
    assert "arxiv_rate_limited" in str(excinfo.value)


async def test_fetch_arxiv_raises_typed_errors_on_http_error() -> None:
    from ai_engine.ingestion.sources import fetch_arxiv

    response = httpx.Response(
        500,
        content=b"upstream boom",
        request=httpx.Request("GET", "https://x"),
    )
    transport = _StubTransport(response)
    from ai_engine.ingestion import sources as sources_mod
    original = sources_mod.httpx.AsyncClient
    sources_mod.httpx.AsyncClient = lambda **kw: original(transport=transport, **kw)
    try:
        with pytest.raises(RuntimeError) as excinfo:
            await fetch_arxiv(max_results=5, categories=["cs.AI"])
    finally:
        sources_mod.httpx.AsyncClient = original
    assert "arxiv_http_error" in str(excinfo.value)


async def test_fetch_arxiv_returns_empty_on_2xx_no_entries() -> None:
    """A 2xx response with zero <entry> elements is NOT a transport
    failure — return an empty list so the caller can decide to retry
    later or downgrade to other sources."""
    from ai_engine.ingestion.sources import fetch_arxiv

    body = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b"<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>"
    )
    response = httpx.Response(200, content=body, request=httpx.Request("GET", "https://x"))
    transport = _StubTransport(response)
    from ai_engine.ingestion import sources as sources_mod
    original = sources_mod.httpx.AsyncClient
    sources_mod.httpx.AsyncClient = lambda **kw: original(transport=transport, **kw)
    try:
        items = await fetch_arxiv(max_results=5, categories=["cs.AI"])
    finally:
        sources_mod.httpx.AsyncClient = original
    assert items == []
