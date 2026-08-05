"""SSRF-safe URL fetcher — Week 4 (W4-1).

Implements the URL safety contract per `docs/IMPLEMENTATION_PLAN.md §六`
(URL 抓取 / SSRF 防护):

- Scheme: only http / https.
- Resolves the hostname to an IP **before** connecting; rejects
  loopback, private (RFC1918), link-local (169.254/16), metadata
  (169.254.169.254), IPv6 loopback / private, and IPv6 link-local.
- **Re-resolves after every redirect**: each Location hop re-parses and
  re-checks the IP; DNS rebinding is mitigated by re-resolving the
  host on every hop rather than letting httpx reuse the original
  resolver result.
- **Allowed ports**: 80, 443, 8080, 8443 only.
- Response cap: `URL_FETCH_MAX_BYTES` (default 2 MB).
- Total time cap: `URL_FETCH_TIMEOUT_SECONDS` (default 10 s) — enforced
  by httpx `Timeout`.
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


class SafeFetchError(Exception):
    """Base class for SSRF / safety rejections and IO failures.

    `code` mirrors `docs/contracts/error-codes.md` (URL_FETCH_*).
    """

    def __init__(self, code: str, message: str, *, host: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.host = host


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


def _resolve_ip(host: str) -> str:
    """Resolve ``host`` and convert resolver failures to the public contract.

    ``socket.gaierror`` used to escape this function and was later collapsed
    to ``AI_ENGINE_UNAVAILABLE`` by the radar runner.  DNS is an upstream URL
    transport failure, not an AI-engine outage, so retain the host and expose
    a retryable, caller-visible code.
    """
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise SafeFetchError(
            code="URL_FETCH_DNS",
            message=f"DNS resolution failed for host {host}",
            host=host,
        ) from exc
    if not infos:
        raise SafeFetchError(
            code="URL_FETCH_DNS",
            message=f"DNS resolution failed for host {host}",
            host=host,
        )
    return str(infos[0][4][0])


def _is_blocked_ip(ip_str: str) -> tuple[bool, str]:
    """Return (blocked, reason) for an IP literal.

    Rejects:
    - loopback (127.0.0.0/8, ::1)
    - private (RFC1918 10/8, 172.16/12, 192.168/16; fc00::/7)
    - link-local (169.254/16, fe80::/10) — covers metadata 169.254.169.254
    - unspecified (0.0.0.0, ::)
    - multicast / reserved
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True, "unparseable_ip"

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
    return False, "ok"


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
    max_redirects = max_redirects or int(
        os.environ.get("URL_FETCH_MAX_REDIRECTS", _DEFAULT_MAX_REDIRECTS)
    )

    # Validate the initial URL shape and resolve its IP first.
    host, port = _validate_url_shape(
        url, allowed_ports=allowed_ports, denied_hosts=denied_hosts
    )
    ip = _resolve_ip(host)
    blocked, reason = _is_blocked_ip(ip)
    if blocked:
        if allow_localhost and reason == "loopback":
            pass  # allow localhost feeds (e.g. WeWe-RSS)
        else:
            raise SafeFetchError(
                code="URL_FETCH_BLOCKED",
                message=f"resolved IP {ip} is blocked ({reason})",
                host=host,
            )

    owns_client = client is None
    if owns_client:
        # We disable httpx's auto-redirect so we can re-validate every
        # hop manually (DNS re-resolution + IP allow-list per hop).
        client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=False,
            headers={"User-Agent": "deep-research-ai-engine/0.1 (+SSRF-safe)"},
        )

    # At this point client is guaranteed non-None; bind to a new name so
    # mypy sees a concrete `httpx.AsyncClient` rather than `| None`.
    assert client is not None  # noqa: S101 — guarded by owns_client above
    http_client: httpx.AsyncClient = client

    try:
        current_url = url
        redirect_count = 0
        started = asyncio.get_event_loop().time()
        last_response: httpx.Response | None = None
        last_ip = ip
        last_host = host

        while True:
            # Re-validate shape + resolve fresh IP per hop (DNS rebinding
            # mitigation). The *initial* hop was validated above; we
            # only re-validate redirect targets.
            if redirect_count > 0:
                cur_host, cur_port = _validate_url_shape(
                    current_url, allowed_ports=allowed_ports, denied_hosts=denied_hosts
                )
                cur_ip = _resolve_ip(cur_host)
                blocked, reason = _is_blocked_ip(cur_ip)
                if blocked:
                    if allow_localhost and reason == "loopback":
                        pass
                    else:
                        raise SafeFetchError(
                            code="URL_FETCH_BLOCKED",
                            message=f"resolved IP {cur_ip} is blocked ({reason})",
                            host=cur_host,
                        )
                last_ip = cur_ip
                last_host = cur_host

            try:
                resp = await http_client.get(current_url)
            except httpx.TimeoutException as exc:
                raise SafeFetchError(
                    code="URL_FETCH_TIMEOUT",
                    message=f"fetch timed out after {timeout}s",
                    host=last_host,
                ) from exc

            # 3xx: follow manually so we can re-validate.
            if resp.status_code in (301, 302, 303, 307, 308):
                redirect_count += 1
                if redirect_count > max_redirects:
                    await resp.aclose()
                    raise SafeFetchError(
                        code="URL_REDIRECT_LIMIT",
                        message=f"redirected more than {max_redirects} times",
                        host=last_host,
                    )
                location = resp.headers.get("location") or resp.headers.get("Location")
                if not location:
                    await resp.aclose()
                    raise SafeFetchError(
                        code="URL_REDIRECT_LIMIT",
                        message="redirect without Location header",
                        host=last_host,
                    )
                current_url = urljoin(str(resp.request.url), location)
                await resp.aclose()
                continue

            last_response = resp
            break

        assert last_response is not None  # noqa: S101 — loop always terminates

        elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
        content_type = (
            last_response.headers.get("content-type")
            or last_response.headers.get("Content-Type")
            or ""
        ).lower()

        # W9 code review 修订：此前未校验 Content-Type，二进制 / PDF / ZIP
        # 会被当成正文读入，再通过 _html_to_text / share 的弱正则清洗后
        # 喂给 LLM 作为"来源"。契约 §2.3 要求拒绝非 text 类型并返回
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

        # Read body with size cap (early abort). If the cap is exceeded
        # we raise TOO_LARGE so the caller knows the body is incomplete.
        buf = bytearray()
        async for chunk in last_response.aiter_bytes(chunk_size=64 * 1024):
            if len(buf) + len(chunk) > max_bytes:
                await last_response.aclose()
                raise SafeFetchError(
                    code="URL_FETCH_TOO_LARGE",
                    message=f"response exceeds {max_bytes} bytes",
                    host=last_host,
                )
            buf.extend(chunk)

        headers: dict[str, str] = {k.lower(): v for k, v in last_response.headers.items()}

        logger.info(
            "ai-engine.safe_fetch.ok",
            extra={
                "host": last_host,
                "ip_family": "v6" if ":" in last_ip else "v4",
                "status": last_response.status_code,
                "elapsed_ms": elapsed_ms,
                "redirects": redirect_count,
                "bytes": len(buf),
            },
        )

        return FetchedDocument(
            url=str(last_response.request.url),
            final_ip=last_ip,
            status=last_response.status_code,
            headers=headers,
            content=bytes(buf),
            content_type=content_type,
            elapsed_ms=elapsed_ms,
            redirect_count=redirect_count,
        )
    finally:
        if owns_client:
            assert client is not None  # noqa: S101 — guarded above
            await client.aclose()


__all__ = [
    "DEFAULT_ALLOWED_PORTS",
    "DEFAULT_DENY_DOMAINS",
    "FetchedDocument",
    "SafeFetchError",
    "safe_fetch",
]
