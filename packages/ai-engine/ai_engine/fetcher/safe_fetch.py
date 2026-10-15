"""SSRF-safe URL fetcher — Week 4 (W4-1).

Implements the URL safety contract per `docs/archive/2026-09-08-implementation-plan.md §六`
(URL 抓取 / SSRF 防护):

- Scheme: only http / https.
- Resolves the hostname to an IP **before** connecting; rejects
  loopback, private (RFC1918), link-local (169.254/16), metadata
  (169.254.169.254), IPv6 loopback / private, and IPv6 link-local.
- Everything that is not globally routable is rejected (incl. CGNAT
  100.64/10, IPv4-mapped / NAT64 / 6to4 IPv6). **All** addresses returned
  by DNS must pass, and the connection is **pinned** to a validated IP
  (Host header + TLS SNI preserved) so httpx cannot re-resolve (DNS
  rebinding). Each redirect hop is re-resolved, re-validated and re-pinned.
  Caller-injected ``client`` objects (tests) cannot be pinned.
- **Allowed ports**: 80, 443, 8080, 8443 only.
- Response cap: `URL_FETCH_MAX_BYTES` (default 2 MB).
- Total time cap: `URL_FETCH_TIMEOUT_SECONDS` (default 10 s) — an overall
  wall-clock deadline across DNS, redirects and body streaming.
- Body is streamed and aborted as soon as it exceeds the byte cap.
- Redirect cap: `URL_FETCH_MAX_REDIRECTS` (default 3); exceeded → 502.

Caller responsibility:
- Convert `.content` (HTML bytes) to Markdown (we never store raw HTML;
  this matches the W3 import worker).
- Strip `<script>`, `<style>`, `<iframe>`, event attributes, and
  dangerous `javascript:` / `data:` URLs.

Error contract (mirrors `docs/contracts/error-codes.md` §URL 抓取):

- `URL_FETCH_BLOCKED`   — scheme / IP / port / domain deny
- `URL_FETCH_TIMEOUT`   — exceeded `URL_FETCH_TIMEOUT_SECONDS`
- `URL_FETCH_TOO_LARGE` — response would exceed `URL_FETCH_MAX_BYTES`
- `URL_REDIRECT_LIMIT`  — exceeded `URL_FETCH_MAX_REDIRECTS`

Logs:
- Never logs URL query strings, body, or fetched content.
- Logs: `host` (no query), final IP family, status, elapsed_ms, error code.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import socket
import time
from dataclasses import dataclass
from typing import Final
from urllib.parse import urljoin, urlsplit

import httpx

logger = logging.getLogger("ai_engine.fetcher.safe_fetch")

# Week 4 contract: ports allowed by default (override via constructor).
DEFAULT_ALLOWED_PORTS: Final[tuple[int, ...]] = (80, 443, 8080, 8443)

# W9 code review 修订：Content-Type 白名单（契约 §2.3）。
# 只允许文本类型；二进制 / application-* 一律拒绝，防止 PDF/ZIP/octet-stream
# 经过弱正则清洗后当成正文喂给 LLM。
_ALLOWED_CONTENT_TYPES: Final[frozenset[str]] = frozenset(
    {
        "text/html", "application/xhtml+xml",
        "text/plain", "text/markdown",
        "application/rss+xml", "application/xml",
        "text/xml", "application/atom+xml",
        "application/json",
    }
)

# Default domain deny list (exact / suffix match).
DEFAULT_DENY_DOMAINS: Final[tuple[str, ...]] = (
    "localhost",
    "metadata.google.internal",
)

# Default max-bytes cap (2 MiB) per IMPLEMENTATION_PLAN §六.
_DEFAULT_MAX_BYTES: Final[int] = 2 * 1024 * 1024

# Default timeout (10 s) per IMPLEMENTATION_PLAN §六.
_DEFAULT_TIMEOUT_SECONDS: Final[float] = 10.0

# Default max redirects (3) per IMPLEMENTATION_PLAN §六.
_DEFAULT_MAX_REDIRECTS: Final[int] = 3
_DNS_RETRIES: Final[int] = max(0, int(os.environ.get("URL_FETCH_DNS_RETRIES", "2")))
_DNS_BACKOFF_SECONDS: Final[float] = max(
    0.0, float(os.environ.get("URL_FETCH_DNS_BACKOFF_SECONDS", "0.1"))
)


class SafeFetchError(Exception):
    """Base class for SSRF / safety rejections and IO failures.

    `code` mirrors `docs/contracts/error-codes.md` (URL_FETCH_*).
    """

    def __init__(self, code: str, message: str, *, host: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.host = host


class UpstreamHttpError(SafeFetchError):
    """A fetched page came back with a non-2xx status (error page, not content).

    ``code`` is ``UPSTREAM_RATE_LIMITED`` for 429 (and 403 with an exhausted
    ``x-ratelimit-remaining``) and ``UPSTREAM_HTTP_ERROR`` otherwise.
    """

    def __init__(self, code: str, message: str, *, status: int, host: str | None = None) -> None:
        super().__init__(code, message, host=host)
        self.status = status


@dataclass(slots=True, frozen=True)
class FetchedDocument:
    """A successfully fetched, safety-checked document."""

    url: str                  # final URL (post-redirects)
    final_ip: str             # last IP we connected to (for logs only)
    status: int               # HTTP status code
    headers: dict[str, str]   # lowercased headers
    content: bytes            # raw bytes (HTML / text / etc.)
    content_type: str         # value of `content-type` header (lowercased)
    elapsed_ms: int           # total wall-clock for the request
    redirect_count: int = 0


def raise_for_document_status(doc: FetchedDocument, *, host: str | None = None) -> None:
    """Raise ``UpstreamHttpError`` unless ``doc`` is a 2xx response.

    HTTP error pages (403/429/5xx) must never be treated as article content.
    """
    status = doc.status
    if 200 <= status < 300:
        return
    remaining = str(doc.headers.get("x-ratelimit-remaining", "")).strip()
    rate_limited = status == 429 or (status == 403 and remaining == "0")
    raise UpstreamHttpError(
        "UPSTREAM_RATE_LIMITED" if rate_limited else "UPSTREAM_HTTP_ERROR",
        f"Upstream returned HTTP {status}",
        status=status,
        host=host,
    )


def _resolve_ips(host: str) -> list[str]:
    """Resolve ``host`` once and return **every** distinct address.

    ``socket.gaierror`` used to escape this function and was later collapsed
    to ``AI_ENGINE_UNAVAILABLE`` by the radar runner.  DNS is an upstream URL
    transport failure, not an AI-engine outage, so retain the host and expose
    a retryable, caller-visible code.

    The caller must validate *all* returned addresses and connect only to one
    of them (see ``_pin_request``) so a second resolution by the HTTP stack
    cannot return a different (internal) address.
    """
    last_error: socket.gaierror | None = None
    for attempt in range(_DNS_RETRIES + 1):
        # The local development network is IPv4-first. Asking for IPv4
        # explicitly avoids intermittent IPv6 resolver failures while
        # retaining a normal-family fallback for public IPv6-only hosts.
        for family in (socket.AF_INET, socket.AF_UNSPEC):
            try:
                infos = socket.getaddrinfo(
                    host,
                    None,
                    family=family,
                    type=socket.SOCK_STREAM,
                    flags=getattr(socket, "AI_ADDRCONFIG", 0),
                )
                if infos:
                    ips: list[str] = []
                    for info in infos:
                        addr = str(info[4][0])
                        if addr not in ips:
                            ips.append(addr)
                    return ips
            except socket.gaierror as exc:
                last_error = exc
        if last_error is not None:
            if attempt < _DNS_RETRIES and _DNS_BACKOFF_SECONDS:
                time.sleep(_DNS_BACKOFF_SECONDS * (2**attempt))

    if last_error is None:
        raise SafeFetchError(
            code="URL_FETCH_DNS",
            message=f"DNS resolution returned no addresses for host {host}",
            host=host,
        )
    raise SafeFetchError(
        code="URL_FETCH_DNS",
        message=(
            f"DNS resolution failed for host {host} after {_DNS_RETRIES + 1} attempts "
            f"(errno={last_error.errno})"
        ),
        host=host,
    ) from last_error


def _resolve_ip(host: str) -> str:
    """Backward-compatible single-address resolver (first record)."""
    return _resolve_ips(host)[0]


def _embedded_ipv4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """IPv4 address smuggled inside an IPv6 one (mapped / NAT64 / 6to4 / Teredo)."""
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip in ipaddress.ip_network("64:ff9b::/96"):  # NAT64 well-known prefix
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    if ip.sixtofour is not None:  # 2002::/16
        return ip.sixtofour
    if ip.teredo is not None:  # 2001::/32 -> (server, client)
        return ip.teredo[0]
    return None


def _is_blocked_ip(ip_str: str) -> tuple[bool, str]:
    """Return (blocked, reason) for an IP literal.

    Anything that is not globally routable is rejected: loopback, RFC1918,
    CGNAT (100.64.0.0/10), link-local / metadata, unspecified, multicast,
    reserved, benchmarking, documentation ranges, ... IPv6 addresses that embed
    an IPv4 address (``::ffff:a.b.c.d``, NAT64, 6to4, Teredo) are judged by the
    embedded IPv4 address.
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True, "unparseable_ip"

    if isinstance(ip, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(ip)
        if embedded is not None:
            return _is_blocked_ip(str(embedded))

    if ip.is_loopback:
        return True, "loopback"
    if ip.is_private:
        return True, "private"
    if ip.is_link_local:
        return True, "link_local"
    if ip.is_unspecified:
        return True, "unspecified"
    if ip.is_multicast:
        return True, "multicast"
    if ip.is_reserved:
        return True, "reserved"
    if not ip.is_global:
        return True, "non_global"
    return False, "ok"


def _validate_resolved(host: str, *, allow_localhost: bool) -> list[str]:
    """Resolve once; reject if ANY address is blocked; return validated IPs."""
    ips = _resolve_ips(host)
    for ip in ips:
        blocked, reason = _is_blocked_ip(ip)
        if blocked and not (allow_localhost and reason == "loopback"):
            raise SafeFetchError(
                code="URL_FETCH_BLOCKED",
                message=f"resolved IP {ip} is blocked ({reason})",
                host=host,
            )
    return ips


def _pin_request(client: httpx.AsyncClient, url: str, ip: str) -> httpx.Request:
    """Build a GET request connecting to ``ip`` while preserving Host + SNI."""
    parsed = httpx.URL(url)
    headers = {"Host": parsed.netloc.decode("ascii")}
    extensions: dict[str, object] = {}
    if parsed.scheme == "https":
        extensions["sni_hostname"] = parsed.host
    return client.build_request(
        "GET", parsed.copy_with(host=ip), headers=headers, extensions=extensions
    )


def _validate_url_shape(
    url: str, *, allowed_ports: tuple[int, ...], denied_hosts: tuple[str, ...]
) -> tuple[str, int]:
    """Validate scheme/host/port; return (host, port).

    Rejects:
    - non-http(s) schemes (`file:`, `gopher:`, `data:`, etc.)
    - missing / empty host
    - userinfo (we don't pass credentials through proxies)
    - non-default ports outside the whitelist
    - domain deny-list hits
    """
    try:
        parts = urlsplit(url)
    except Exception as exc:
        raise SafeFetchError(
            code="URL_FETCH_BLOCKED",
            message=f"invalid URL: {type(exc).__name__}",
        ) from exc

    if parts.scheme not in ("http", "https"):
        raise SafeFetchError(
            code="URL_FETCH_BLOCKED",
            message=f"scheme {parts.scheme!r} is not http/https",
        )
    if parts.username or parts.password:
        raise SafeFetchError(
            code="URL_FETCH_BLOCKED",
            message="URL contains userinfo (not allowed)",
        )

    host = parts.hostname or ""
    if not host:
        raise SafeFetchError(
            code="URL_FETCH_BLOCKED",
            message="URL has empty host",
        )

    lowered = host.lower().rstrip(".")
    for denied in denied_hosts:
        if lowered == denied or lowered.endswith("." + denied):
            raise SafeFetchError(
                code="URL_FETCH_BLOCKED",
                message=f"host {host} is in domain deny list",
                host=host,
            )

    port = parts.port
    if port is None:
        port = 443 if parts.scheme == "https" else 80

    if port not in allowed_ports:
        raise SafeFetchError(
            code="URL_FETCH_BLOCKED",
            message=f"port {port} is not in allowed ports",
            host=host,
        )

    return host, port


async def safe_fetch(
    url: str,
    *,
    max_bytes: int | None = None,
    timeout: float | None = None,
    max_redirects: int | None = None,
    client: httpx.AsyncClient | None = None,
    extra_denied_hosts: tuple[str, ...] = (),
    extra_allowed_ports: tuple[int, ...] = (),
    allow_localhost: bool = False,
    allowed_hosts: tuple[str, ...] | None = None,
) -> FetchedDocument:
    """Fetch `url` with SSRF guards; returns a `FetchedDocument`.

    Raises `SafeFetchError` (with `code` matching the contract) on:
    - URL shape / scheme / host / port rejection
    - DNS resolution failure or blocked IP (private/loopback/link-local/...)
    - redirect limit exceeded
    - timeout (httpx.TimeoutException → URL_FETCH_TIMEOUT)
    - response > max_bytes (the *would be* cap; we abort early).

    Logs:
    - `host` (no query), final IP family (v4/v6), elapsed_ms, status, error code.
    Never logs: query string, body, content.
    """
    allowed_ports = (
        tuple(sorted(set(DEFAULT_ALLOWED_PORTS) | set(extra_allowed_ports)))
        if extra_allowed_ports
        else DEFAULT_ALLOWED_PORTS
    )
    if allow_localhost:
        denied_hosts = tuple(
            h for h in (set(DEFAULT_DENY_DOMAINS) | set(extra_denied_hosts))
            if h != "localhost"
        )
    else:
        denied_hosts = tuple(set(DEFAULT_DENY_DOMAINS) | set(extra_denied_hosts))

    max_bytes = max_bytes or int(os.environ.get("URL_FETCH_MAX_BYTES", _DEFAULT_MAX_BYTES))
    timeout = timeout or float(
        os.environ.get("URL_FETCH_TIMEOUT_SECONDS", _DEFAULT_TIMEOUT_SECONDS)
    )
    if max_redirects is None:
        max_redirects = int(os.environ.get("URL_FETCH_MAX_REDIRECTS", _DEFAULT_MAX_REDIRECTS))

    # Validate the initial URL shape up front (fail fast, no DNS for bad URLs).
    host, _port = _validate_url_shape(
        url, allowed_ports=allowed_ports, denied_hosts=denied_hosts
    )
    if allowed_hosts is not None and host.lower().rstrip(".") not in allowed_hosts:
        raise SafeFetchError(
            code="URL_FETCH_BLOCKED", message="host is not allowed", host=host,
        )

    owns_client = client is None
    if owns_client:
        # We disable httpx's auto-redirect so we can re-validate every
        # hop manually (DNS resolution + IP allow-list per hop).
        client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=False,
            headers={"User-Agent": "deep-research-ai-engine/0.1 (+SSRF-safe)"},
        )

    # At this point client is guaranteed non-None; bind to a new name so
    # mypy sees a concrete `httpx.AsyncClient` rather than `| None`.
    assert client is not None  # noqa: S101 — guarded by owns_client above
    http_client: httpx.AsyncClient = client
    loop = asyncio.get_running_loop()
    started = loop.time()

    async def _run() -> FetchedDocument:
        current_url = url
        redirect_count = 0
        last_host = host
        last_ip = ""

        while True:
            cur_host, _cur_port = _validate_url_shape(
                current_url, allowed_ports=allowed_ports, denied_hosts=denied_hosts
            )
            if allowed_hosts is not None and cur_host.lower().rstrip(".") not in allowed_hosts:
                raise SafeFetchError(
                    code="URL_FETCH_BLOCKED",
                    message=(
                        "host is not allowed" if redirect_count == 0
                        else "redirect host is not allowed"
                    ),
                    host=cur_host,
                )
            # Resolve ONCE per hop and validate EVERY returned address.
            ips = _validate_resolved(cur_host, allow_localhost=allow_localhost)
            last_host = cur_host

            resp: httpx.Response | None = None
            if owns_client:
                # Pin the connection to a validated IP (Host + SNI preserved) so
                # the HTTP stack cannot re-resolve to a different address.
                connect_error: httpx.ConnectError | None = None
                for candidate in ips:
                    try:
                        resp = await http_client.send(
                            _pin_request(http_client, current_url, candidate),
                            stream=True,
                        )
                        last_ip = candidate
                        break
                    except httpx.ConnectError as exc:
                        connect_error = exc
                if resp is None:
                    assert connect_error is not None  # noqa: S101
                    raise connect_error
            else:
                # Caller-supplied client (tests / custom transports): cannot pin.
                resp = await http_client.send(
                    http_client.build_request("GET", current_url), stream=True
                )
                last_ip = ips[0]

            try:
                # 3xx: follow manually so we can re-validate.
                if resp.status_code in (301, 302, 303, 307, 308):
                    redirect_count += 1
                    if redirect_count > max_redirects:
                        raise SafeFetchError(
                            code="URL_REDIRECT_LIMIT",
                            message=f"redirected more than {max_redirects} times",
                            host=last_host,
                        )
                    location = resp.headers.get("location")
                    if not location:
                        raise SafeFetchError(
                            code="URL_REDIRECT_LIMIT",
                            message="redirect without Location header",
                            host=last_host,
                        )
                    current_url = urljoin(current_url, location)
                    continue

                content_type = (resp.headers.get("content-type") or "").lower()

                # W9 code review 修订：契约 §2.3 要求拒绝非 text 类型并返回
                # CONTENT_TYPE_REJECTED（HTTP 415 → 映射为 Bad Request）。
                if content_type:
                    mime = content_type.split(";", 1)[0].strip()
                    if mime not in _ALLOWED_CONTENT_TYPES:
                        raise SafeFetchError(
                            code="CONTENT_TYPE_REJECTED",
                            message=f"Content-Type {mime!r} not allowed; "
                            f"expect {_ALLOWED_CONTENT_TYPES}",
                            host=last_host,
                        )

                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise SafeFetchError(
                        code="URL_FETCH_TOO_LARGE",
                        message=f"response exceeds {max_bytes} bytes",
                        host=last_host,
                    )

                # Stream with early abort: never pull more than max_bytes + 1 chunk.
                buf = bytearray()
                async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                    if len(buf) + len(chunk) > max_bytes:
                        raise SafeFetchError(
                            code="URL_FETCH_TOO_LARGE",
                            message=f"response exceeds {max_bytes} bytes",
                            host=last_host,
                        )
                    buf.extend(chunk)

                headers: dict[str, str] = {k.lower(): v for k, v in resp.headers.items()}
                elapsed_ms = int((loop.time() - started) * 1000)

                logger.info(
                    "ai-engine.safe_fetch.ok",
                    extra={
                        "host": last_host,
                        "ip_family": "v6" if ":" in last_ip else "v4",
                        "status": resp.status_code,
                        "elapsed_ms": elapsed_ms,
                        "redirects": redirect_count,
                        "bytes": len(buf),
                    },
                )

                return FetchedDocument(
                    url=current_url,
                    final_ip=last_ip,
                    status=resp.status_code,
                    headers=headers,
                    content=bytes(buf),
                    content_type=content_type,
                    elapsed_ms=elapsed_ms,
                    redirect_count=redirect_count,
                )
            finally:
                await resp.aclose()

    try:
        # Overall wall-clock deadline (DNS + every hop + body streaming), not
        # just httpx's per-read timeout: a slow-drip server cannot hold us.
        async with asyncio.timeout(timeout):
            return await _run()
    except (httpx.TimeoutException, TimeoutError) as exc:
        raise SafeFetchError(
            code="URL_FETCH_TIMEOUT",
            message=f"fetch timed out after {timeout}s",
            host=host,
        ) from exc
    finally:
        if owns_client:
            await http_client.aclose()


__all__ = [
    "DEFAULT_ALLOWED_PORTS",
    "DEFAULT_DENY_DOMAINS",
    "FetchedDocument",
    "SafeFetchError",
    "UpstreamHttpError",
    "raise_for_document_status",
    "safe_fetch",
]
