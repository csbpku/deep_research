"""Regression tests for safe_fetch SSRF / resource-limit hardening."""

from __future__ import annotations

import asyncio
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import httpx
import pytest

from ai_engine.fetcher import safe_fetch as sf


@pytest.mark.parametrize(
    "ip",
    [
        "100.64.0.1",
        "100.100.100.200",
        "64:ff9b::a9fe:a9fe",
        "::ffff:169.254.169.254",
        "::ffff:127.0.0.1",
        "192.0.0.170",
        "2002:a9fe:a9fe::1",
        "198.18.0.1",
        "fd00::1",
        "0.0.0.0",
    ],
)
def test_non_global_addresses_blocked(ip: str) -> None:
    assert sf._is_blocked_ip(ip)[0] is True


def test_public_addresses_allowed() -> None:
    assert sf._is_blocked_ip("93.184.216.34") == (False, "ok")
    assert sf._is_blocked_ip("2606:4700:4700::1111") == (False, "ok")


@pytest.mark.asyncio
async def test_every_dns_record_is_validated(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake(host: str, *a: Any, **k: Any) -> list[Any]:
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0)),
        ]

    monkeypatch.setattr(socket, "getaddrinfo", fake)
    with pytest.raises(sf.SafeFetchError) as err:
        await sf.safe_fetch("http://evil.example/")
    assert err.value.code == "URL_FETCH_BLOCKED"
    assert "127.0.0.1" in err.value.message


class _Handler(BaseHTTPRequestHandler):
    seen_hosts: list[str] = []

    def do_GET(self) -> None:  # noqa: N802
        type(self).seen_hosts.append(self.headers.get("Host", ""))
        body = b"hello"
        self.send_response(200)
        self.send_header("content-type", "text/plain")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a: Any) -> None:
        pass


@pytest.mark.asyncio
async def test_connection_pinned_to_validated_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    """Resolve once; connect to the validated IP with the original Host header."""
    _Handler.seen_hosts = []
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    calls = {"n": 0}
    real = socket.getaddrinfo

    def fake(host: Any, *a: Any, **k: Any) -> Any:
        if host == "rebind.example":
            calls["n"] += 1
            if calls["n"] > 1:  # a second resolution would hit this
                raise socket.gaierror(socket.EAI_NONAME, "rebound")
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]
        return real(host, *a, **k)

    monkeypatch.setattr(socket, "getaddrinfo", fake)
    try:
        doc = await sf.safe_fetch(
            f"http://rebind.example:{port}/x",
            allow_localhost=True,
            extra_allowed_ports=(port,),
        )
    finally:
        srv.shutdown()
    assert doc.content == b"hello"
    assert doc.final_ip == "127.0.0.1"
    assert calls["n"] == 1
    assert _Handler.seen_hosts == [f"rebind.example:{port}"]
    assert doc.url == f"http://rebind.example:{port}/x"


def test_pin_request_preserves_host_and_sni() -> None:
    client = httpx.AsyncClient()
    req = sf._pin_request(client, "https://example.com/a?b=1", "93.184.216.34")
    assert req.url.host == "93.184.216.34"
    assert req.headers["host"] == "example.com"
    assert req.extensions["sni_hostname"] == "example.com"
    req6 = sf._pin_request(client, "http://example.com:8080/", "2606:4700::1")
    assert req6.headers["host"] == "example.com:8080"
    assert "sni_hostname" not in req6.extensions


@pytest.mark.asyncio
async def test_oversized_body_aborts_early(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sf, "_resolve_ips", lambda h: ["93.184.216.34"])
    consumed = {"n": 0}

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):  # type: ignore[no-untyped-def]
            for _ in range(200):
                consumed["n"] += 65536
                yield b"a" * 65536

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/html"}, stream=Body())

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(sf.SafeFetchError) as err:
        await sf.safe_fetch("https://big.example/", client=client, max_bytes=1024 * 1024)
    assert err.value.code == "URL_FETCH_TOO_LARGE"
    assert consumed["n"] <= 1024 * 1024 + 2 * 65536


@pytest.mark.asyncio
async def test_declared_content_length_rejected_without_reading(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sf, "_resolve_ips", lambda h: ["93.184.216.34"])
    consumed = {"n": 0}

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):  # type: ignore[no-untyped-def]
            consumed["n"] += 1
            yield b"a"

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/html", "content-length": "99999999"},
            stream=Body(),
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(sf.SafeFetchError) as err:
        await sf.safe_fetch("https://big.example/", client=client, max_bytes=1024)
    assert err.value.code == "URL_FETCH_TOO_LARGE"
    assert consumed["n"] == 0


@pytest.mark.asyncio
async def test_slow_drip_body_hits_overall_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sf, "_resolve_ips", lambda h: ["93.184.216.34"])

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):  # type: ignore[no-untyped-def]
            for _ in range(1000):
                await asyncio.sleep(0.05)  # each read is "fast"; total is not
                yield b"a"

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/html"}, stream=Body())

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(sf.SafeFetchError) as err:
        await sf.safe_fetch("https://slow.example/", client=client, timeout=0.3)
    assert err.value.code == "URL_FETCH_TIMEOUT"
