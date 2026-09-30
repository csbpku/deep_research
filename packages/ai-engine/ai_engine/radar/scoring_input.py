"""Transient evidence for missing external-reading scores and judgements.

Only derived fields are persisted. Source text stays in memory for a single
attempt.
"""

from __future__ import annotations

import base64
import json
import logging
import re
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

from bs4 import BeautifulSoup

from ai_engine.fetcher.safe_fetch import FetchedDocument, safe_fetch
from ai_engine.radar.sync_runner import (
    _extract_article_content,
    _is_low_quality_content,
    _scoreability,
    _shell_content_label,
)

logger = logging.getLogger("ai_engine.radar.scoring_input")

Fetcher = Callable[..., Awaitable[FetchedDocument]]

_SOURCE_HOSTS: dict[str, frozenset[str]] = {
    "arxiv": frozenset({"arxiv.org", "github.com"}),
    "devto": frozenset({"dev.to", "github.com"}),
    "github": frozenset({"github.com"}),
    "github_trending": frozenset({"github.com"}),
    "vendor_news": frozenset({"deepmind.google", "www.anthropic.com"}),
    "rss": frozenset({"www.qbitai.com", "arxiv.org", "github.com"}),
}
_REPO_PART = re.compile(r"^[A-Za-z0-9_.-]+$")


async def _github_readme_input(
    url: str,
    *,
    fetcher: Fetcher,
) -> tuple[str, str] | None:
    parts = urlsplit(url)
    segments = parts.path.strip("/").split("/")
    if (
        parts.hostname != "github.com"
        or len(segments) != 2
        or any(not _REPO_PART.fullmatch(part) or part in {".", ".."} for part in segments)
    ):
        return None
    owner, repo = segments
    try:
        fetched = await fetcher(
            f"https://api.github.com/repos/{owner}/{repo}/readme",
            max_bytes=256_000,
            timeout=10.0,
            max_redirects=0,
            allowed_hosts=("api.github.com",),
        )
        if fetched.status != 200 or urlsplit(fetched.url).hostname != "api.github.com":
            return None
        payload = json.loads(fetched.content)
        if not isinstance(payload, dict) or payload.get("encoding") != "base64":
            return None
        encoded = payload.get("content")
        if not isinstance(encoded, str):
            return None
        text = base64.b64decode(encoded, validate=False).decode("utf-8", errors="replace")
    except Exception:
        return None
    if not _usable_content(text, source_type="github", url=url):
        return None
    return text[:18_000], "transient_source"


def _usable_content(text: str, *, source_type: str, url: str) -> bool:
    return (
        _scoreability(text) is not None
        and not _is_low_quality_content(text)
        and _shell_content_label(text, source_type=source_type, url=url) is None
    )


def _arxiv_abstract_input(html: str, url: str) -> tuple[str, str] | None:
    paper = re.fullmatch(r"/abs/(\d{4}\.\d{4,5})(?:v\d+)?/?", urlsplit(url).path)
    if paper is None:
        return None
    soup = BeautifulSoup(html, "html.parser")
    title_node = soup.select_one("h1.title")
    abstract_node = soup.select_one("blockquote.abstract")
    if title_node is None or abstract_node is None:
        return None
    title = re.sub(
        r"^Title:\s*", "", title_node.get_text(" ", strip=True), flags=re.I,
    ).strip()
    abstract = re.sub(
        r"^Abstract:\s*", "", abstract_node.get_text(" ", strip=True), flags=re.I,
    ).strip()
    if not title or _scoreability(abstract) is None:
        return None
    text = f"# arXiv:{paper.group(1)}\n# Title:{title}\n\nAbstract: {abstract}"
    if not _usable_content(text, source_type="arxiv", url=url):
        return None
    return text[:18_000], "source_abstract"


async def transient_scoring_input(
    pool: Any,
    row: dict[str, Any],
    *,
    fetcher: Fetcher = safe_fetch,
) -> tuple[str, str] | None:
    """Use a substantial source excerpt or a bounded, non-persisted page read.

    Never follow an arbitrary submitted link: this path is limited to
    source-synced external reading rows and a small set of known source hosts.
    """
    if row.get("source") != "daily" or (
        "external_reading" not in (row.get("tags") or [])
        and row.get("status") != "archived"
    ):
        return None
    source_type = str(row.get("sourceType") or "")
    url = str(row.get("url") or "")
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        return None
    excerpt_input: tuple[str, str] | None = None
    if row.get("status") != "archived" and row.get("syncRunId") and row.get("canonicalUrl"):
        async with pool.connection() as conn:
            excerpt = await (
                await conn.execute(
                    'SELECT "body" FROM "radar_sync_diagnostics" '
                    'WHERE "runId" = %s AND "canonicalUrl" = %s '
                    "AND \"reasonCode\" = 'PENDING_SCORE' "
                    'ORDER BY "createdAt" DESC LIMIT 1',
                    (row["syncRunId"], row["canonicalUrl"]),
                )
            ).fetchone()
        text = str(dict(excerpt).get("body") or "").strip() if excerpt else ""
        if _usable_content(text, source_type=source_type, url=url):
            excerpt_input = (text[:2_000], "source_excerpt")
            if _scoreability(text) == "full":
                return excerpt_input

    host = parts.hostname
    allowed_hosts = _SOURCE_HOSTS.get(source_type, frozenset())
    if host not in allowed_hosts:
        return excerpt_input
    if host == "github.com":
        readme = await _github_readme_input(url, fetcher=fetcher)
        if readme is not None:
            return readme
    try:
        fetched = await fetcher(
            url, max_bytes=512_000 if host in {
                "github.com", "dev.to", "www.anthropic.com", "deepmind.google",
            } else 256_000,
            timeout=10.0, max_redirects=2,
            allowed_hosts=tuple(sorted(allowed_hosts)),
        )
        if fetched.status != 200 or urlsplit(fetched.url).hostname not in allowed_hosts:
            return excerpt_input
        if source_type == "arxiv" and host == "arxiv.org":
            return _arxiv_abstract_input(
                fetched.content.decode("utf-8", errors="replace"), fetched.url,
            ) or excerpt_input
        text = _extract_article_content(
            fetched.content.decode("utf-8", errors="replace"),
            fetched.url,
            source_type,
            max_chars=18_000,
        )
    except Exception as exc:
        logger.warning(
            "radar.score_input_fetch_failed source_type=%s host=%s error_kind=%s code=%s",
            source_type, host, type(exc).__name__, getattr(exc, "code", "unknown"),
        )
        return excerpt_input
    if not _usable_content(text, source_type=source_type, url=fetched.url):
        return excerpt_input
    return text, "transient_source"


__all__ = ["transient_scoring_input"]
