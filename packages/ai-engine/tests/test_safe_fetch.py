"""SSRF-safe URL fetcher tests — Week 4 (W4-1, IMPLEMENTATION_PLAN §六).

12-case test matrix from IMPLEMENTATION_PLAN §六:
- 127.0.0.1 loopback IPv4
- RFC1918 private (10.0.0.0/8, 172.16/12, 192.168/16)
- IPv6 loopback (::1)
- metadata IP (169.254.169.254)
- DNS rebinding simulation (first resolve ok, then resolve to private)
- redirect to private IP (after 1 public hop)
- oversized response (>2MB → URL_FETCH_TOO_LARGE)
- timeout (→ URL_FETCH_TIMEOUT)
- scheme rejection (file://)
- userinfo rejection (http://user:pass@)
- empty / missing host
- successful public fetch + Markdown-ready body returned

Notes on test design:
- We use httpx.MockTransport to simulate every IO path. The
  transport's URL is whatever the safe_fetch code is requesting, and
  we record the *requested URL* to assert redirect chains.
- For DNS rebinding, we use a hostname that resolves to 127.0.0.1
  via `/etc/hosts` injection (monkeypatched `_resolve_ip`).
"""

from __future__ import annotations

import socket
from typing import Any, Callable

import httpx
import pytest

from ai_engine.fetcher.safe_fetch import (
    DEFAULT_ALLOWED_PORTS,
    FetchedDocument,
    SafeFetchError,
    _resolve_ip,
    safe_fetch,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _MockTransport(httpx.AsyncBaseTransport):
    """Stub transport — routes by host.

    `routes` is a dict: host -> handler(httpx.Request) -> httpx.Response.
    Hosts not listed raise a synthetic `URL_FETCH_BLOCKED`-style error
    by responding with 599; but we never reach here in practice because
    `_resolve_ip` is monkeypatched in tests to control DNS.

    `record` collects every request URL the transport saw — useful for
    asserting on the manual redirect chain.
    """

    def __init__(
        self,
        routes: dict[str, Callable[[httpx.Request], httpx.Response]],
    ) -> None:
        self._routes = routes
        self.record: list[str] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        # url is the *target* URL the safe_fetch code is asking for.
        self.record.append(str(request.url))
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


def _ok_response(body: bytes = b"hi", content_type: str = "text/html") -> httpx.Response:
    return httpx.Response(
        200,
        content=body,
        headers={"content-type": content_type},
        request=httpx.Request("GET", "http://public.example/"),
    )


def _redirect_response(location: str, *, status: int = 302) -> httpx.Response:
    return httpx.Response(
        status,
        headers={"location": location},
        request=httpx.Request("GET", "http://public.example/"),
    )


def test_dns_resolver_retries_transient_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """Transient resolver failures should recover before becoming URL_FETCH_DNS."""
    calls = 0

    def flaky_getaddrinfo(host: str, port: Any, **kwargs: Any) -> list[tuple[Any, ...]]:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise socket.gaierror(socket.EAI_AGAIN, "temporary failure")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", flaky_getaddrinfo)
    monkeypatch.setattr("ai_engine.fetcher.safe_fetch._DNS_RETRIES", 2)
    monkeypatch.setattr("ai_engine.fetcher.safe_fetch._DNS_BACKOFF_SECONDS", 0.0)

    assert _resolve_ip("temporary.example") == "8.8.8.8"
    assert calls == 3


@pytest.fixture
def patch_resolver(monkeypatch: pytest.MonkeyPatch) -> Callable[[str, str], None]:
    """Factory: install a stub resolver.

    Usage: patch_resolver("public.example", "8.8.8.8")
    """

    table: dict[str, str] = {}

    def _resolve(host: str) -> str:
        if host in table:
            return table[host]
        # Fall back to socket.getaddrinfo so e.g. localhost works.
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        if not infos:
            raise SafeFetchError(
                code="URL_FETCH_BLOCKED",
                message=f"DNS resolution failed for host {host}",
                host=host,
            )
        return str(infos[0][4][0])

    monkeypatch.setattr("ai_engine.fetcher.safe_fetch._resolve_ip", _resolve)
    return table.__setitem__


# ---------------------------------------------------------------------------
# Test matrix
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ssrf_01_loopback_ipv4_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """127.0.0.1 loopback rejected (URL_FETCH_BLOCKED)."""
    patch_resolver("loop.example", "127.0.0.1")
    transport = _MockTransport({"loop.example": lambda r: _ok_response()})
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("http://loop.example/", client=client)
    assert exc_info.value.code == "URL_FETCH_BLOCKED"
    assert "loopback" in exc_info.value.message


@pytest.mark.asyncio
async def test_ssrf_02_private_rfc1918_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """RFC1918 (10.0.0.0/8) private IP rejected."""
    patch_resolver("private.example", "10.1.2.3")
    transport = _MockTransport({"private.example": lambda r: _ok_response()})
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("http://private.example/", client=client)
    assert exc_info.value.code == "URL_FETCH_BLOCKED"
    assert "private" in exc_info.value.message


@pytest.mark.asyncio
async def test_ssrf_03_private_172_16_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """172.16.0.0/12 also blocked."""
    patch_resolver("p.example", "172.20.5.6")
    transport = _MockTransport({"p.example": lambda r: _ok_response()})
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("http://p.example/", client=client)
    assert exc_info.value.code == "URL_FETCH_BLOCKED"


@pytest.mark.asyncio
async def test_ssrf_04_private_192_168_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """192.168.0.0/16 also blocked."""
    patch_resolver("p.example", "192.168.1.1")
    transport = _MockTransport({"p.example": lambda r: _ok_response()})
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("http://p.example/", client=client)
    assert exc_info.value.code == "URL_FETCH_BLOCKED"


@pytest.mark.asyncio
async def test_ssrf_05_ipv6_loopback_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """::1 loopback rejected."""
    patch_resolver("v6.example", "::1")
    transport = _MockTransport({"v6.example": lambda r: _ok_response()})
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("http://v6.example/", client=client)
    assert exc_info.value.code == "URL_FETCH_BLOCKED"


@pytest.mark.asyncio
async def test_ssrf_06_metadata_ip_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """169.254.169.254 (AWS / GCP metadata) rejected."""
    patch_resolver("meta.example", "169.254.169.254")
    transport = _MockTransport({"meta.example": lambda r: _ok_response()})
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("http://meta.example/", client=client)
    assert exc_info.value.code == "URL_FETCH_BLOCKED"
    assert ("link_local" in exc_info.value.message
            or "private" in exc_info.value.message)


@pytest.mark.asyncio
async def test_ssrf_07_dns_rebinding_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """DNS rebinding: first resolve looks safe but follow-up returns private IP.

    The hostname resolves to 8.8.8.8 initially (passes first check),
    then on the *next* redirect hop, _resolve_ip returns 10.0.0.1.
    Safe-fetch must re-resolve and reject.
    """
    # Resolver returns 8.8.8.8 first, then 10.0.0.1 on later calls.
    counter = {"n": 0}

    def _resolve_rebind(host: str) -> str:
        counter["n"] += 1
        return "8.8.8.8" if counter["n"] == 1 else "10.0.0.1"

    import ai_engine.fetcher.safe_fetch as sf

    # Override resolver directly so we can mutate per-call.
    prev = sf._resolve_ip
    sf._resolve_ip = _resolve_rebind  # type: ignore[assignment]

    def _resolve_safe(host: str) -> str:
        return "8.8.8.8"

    # First-hop: public. Second-hop: private IP target.
    transport = _MockTransport(
        {
            "public.example": lambda r: _redirect_response("http://rebind.example/"),
            # rebind.example shouldn't even be hit — the IP check
            # fires first.
            "rebind.example": lambda r: _ok_response(),
        }
    )
    client = _client(transport)

    try:
        sf._resolve_ip = _resolve_safe  # type: ignore[assignment]  # shape check ok
        # The redirect path calls _validate_url_shape + _resolve_ip
        # again; restore the rebind variant for that.
        sf._resolve_ip = _resolve_rebind  # type: ignore[assignment]
        with pytest.raises(SafeFetchError) as exc_info:
            await safe_fetch("http://public.example/", client=client)
        assert exc_info.value.code == "URL_FETCH_BLOCKED"
        assert "10.0.0.1" in exc_info.value.message
    finally:
        sf._resolve_ip = prev  # type: ignore[assignment]


@pytest.mark.asyncio
async def test_ssrf_08_redirect_to_private_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """Public host → redirect → private host. The private hop must be rejected."""
    patch_resolver("public.example", "8.8.8.8")
    patch_resolver("internal.example", "10.0.0.5")
    transport = _MockTransport(
        {
            "public.example": lambda r: _redirect_response("http://internal.example/"),
            "internal.example": lambda r: _ok_response(),
        }
    )
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("http://public.example/", client=client)
    assert exc_info.value.code == "URL_FETCH_BLOCKED"
    assert "internal.example" in (exc_info.value.host or "")


@pytest.mark.asyncio
async def test_ssrf_09_oversized_response_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """Body larger than max_bytes → URL_FETCH_TOO_LARGE."""
    patch_resolver("big.example", "8.8.8.8")

    async def handler(request: httpx.Request) -> httpx.Response:
        # Build a response whose body is bigger than max_bytes.
        body = b"x" * (3 * 1024 * 1024)  # 3 MB
        return httpx.Response(
            200,
            content=body,
            headers={"content-type": "text/html"},
            request=request,
        )

    transport = _MockTransport({"big.example": handler})
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch(
            "http://big.example/",
            client=client,
            max_bytes=2 * 1024 * 1024,
        )
    assert exc_info.value.code == "URL_FETCH_TOO_LARGE"


@pytest.mark.asyncio
async def test_ssrf_10_timeout_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """Timeout → URL_FETCH_TIMEOUT."""
    patch_resolver("slow.example", "8.8.8.8")

    async def handler(request: httpx.Request) -> httpx.Response:
        # httpx.TimeoutException maps to URL_FETCH_TIMEOUT in safe_fetch.
        raise httpx.TimeoutException("simulated", request=request)

    transport = _MockTransport({"slow.example": handler})
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch(
            "http://slow.example/",
            client=client,
            timeout=0.01,
        )
    assert exc_info.value.code == "URL_FETCH_TIMEOUT"


@pytest.mark.asyncio
async def test_dns_resolution_failure_has_specific_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resolver failures are transport errors, not AI-engine outages."""
    def failed_resolver(host: str, *args: Any, **kwargs: Any) -> list[Any]:
        raise socket.gaierror(socket.EAI_NONAME, "name not known")

    monkeypatch.setattr(socket, "getaddrinfo", failed_resolver)
    client = _client(_MockTransport({}))
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("https://dns-failure.example/", client=client)
    assert exc_info.value.code == "URL_FETCH_DNS"
    assert exc_info.value.host == "dns-failure.example"


@pytest.mark.asyncio
async def test_ssrf_11_scheme_file_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """file:// scheme is rejected."""
    transport = _MockTransport({})
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("file:///etc/passwd", client=client)
    assert exc_info.value.code == "URL_FETCH_BLOCKED"
    assert "scheme" in exc_info.value.message


@pytest.mark.asyncio
async def test_ssrf_12_userinfo_and_empty_host_rejected(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """userinfo / empty host are both rejected as URL_FETCH_BLOCKED."""
    transport = _MockTransport({})
    client = _client(transport)
    # userinfo
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("http://user:pass@public.example/", client=client)
    assert exc_info.value.code == "URL_FETCH_BLOCKED"
    assert "userinfo" in exc_info.value.message
    # empty host — urlsplit treats "http:///path" as host=None.
    with pytest.raises(SafeFetchError) as exc_info2:
        await safe_fetch("http:///just/a/path", client=client)
    assert exc_info2.value.code == "URL_FETCH_BLOCKED"


# ---------------------------------------------------------------------------
# Bonus happy-path + non-default-port coverage
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ssrf_happy_public_fetch_returns_document(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """Successful public fetch returns a FetchedDocument with bytes ready."""
    patch_resolver("ok.example", "8.8.8.8")
    body = b"<html><body>hi</body></html>"

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=body, headers={"content-type": "text/html"}, request=request,
        )

    transport = _MockTransport({"ok.example": handler})
    client = _client(transport)
    doc = await safe_fetch("http://ok.example/page", client=client)
    assert isinstance(doc, FetchedDocument)
    assert doc.status == 200
    assert doc.content == body
    assert doc.content_type == "text/html"
    assert doc.final_ip == "8.8.8.8"


@pytest.mark.asyncio
async def test_ssrf_port_whitelist_excludes_other_ports(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """Port 22 / 25 / 3306 are rejected even when host resolves to a public IP."""
    patch_resolver("ssh.example", "8.8.8.8")
    transport = _MockTransport({"ssh.example": lambda r: _ok_response()})
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("http://ssh.example:22/", client=client)
    assert exc_info.value.code == "URL_FETCH_BLOCKED"
    assert "port" in exc_info.value.message


@pytest.mark.asyncio
async def test_ssrf_redirect_chain_compliance_with_max(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """A redirect chain of 3 hops completes; 4 hops errors."""
    patch_resolver("a.example", "8.8.8.8")
    patch_resolver("b.example", "8.8.4.4")
    patch_resolver("c.example", "1.1.1.1")
    patch_resolver("d.example", "8.8.8.8")  # would succeed if reached

    def handler_for(host: str) -> Any:
        if host == "a.example":
            return lambda r: _redirect_response("http://b.example/")
        if host == "b.example":
            return lambda r: _redirect_response("http://c.example/")
        if host == "c.example":
            return lambda r: _redirect_response("http://d.example/")
        if host == "d.example":
            return lambda r: _ok_response(b"final")
        return None

    transport = _MockTransport({h: handler_for(h) for h in ("a.example", "b.example", "c.example", "d.example")})
    client = _client(transport)
    doc = await safe_fetch("http://a.example/", client=client, max_redirects=3)
    assert doc.status == 200
    assert doc.content == b"final"
    assert doc.redirect_count == 3


@pytest.mark.asyncio
async def test_ssrf_redirect_over_limit_raises(
    patch_resolver: Callable[[str, str], None],
) -> None:
    """4 redirects with max=3 → URL_REDIRECT_LIMIT."""
    patch_resolver("a.example", "8.8.8.8")
    patch_resolver("b.example", "8.8.4.4")
    patch_resolver("c.example", "1.1.1.1")
    patch_resolver("d.example", "8.8.8.8")

    def handler_for(host: str) -> Any:
        if host == "a.example":
            return lambda r: _redirect_response("http://b.example/")
        if host == "b.example":
            return lambda r: _redirect_response("http://c.example/")
        if host == "c.example":
            return lambda r: _redirect_response("http://d.example/")
        if host == "d.example":
            return lambda r: _redirect_response("http://a.example/")
        return None

    transport = _MockTransport(
        {h: handler_for(h) for h in ("a.example", "b.example", "c.example", "d.example")}
    )
    client = _client(transport)
    with pytest.raises(SafeFetchError) as exc_info:
        await safe_fetch("http://a.example/", client=client, max_redirects=3)
    assert exc_info.value.code == "URL_REDIRECT_LIMIT"


@pytest.mark.asyncio
async def test_ssrf_allowed_ports_constant() -> None:
    """The default allowed ports are exactly 80/443/8080/8443."""
    assert DEFAULT_ALLOWED_PORTS == (80, 443, 8080, 8443)
