"""Transient evidence for missing external-reading scores.

Only the resulting score is persisted. Source text stays in memory for the
duration of a single scoring attempt.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

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


def _usable_content(text: str, *, source_type: str, url: str) -> bool:
    return (
        _scoreability(text) is not None
        and not _is_low_quality_content(text)
        and _shell_content_label(text, source_type=source_type, url=url) is None
    )


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
    if row.get("source") != "daily" or "external_reading" not in (row.get("tags") or []):
        return None
    source_type = str(row.get("sourceType") or "")
    url = str(row.get("url") or "")
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        return None
    excerpt_input: tuple[str, str] | None = None
    if row.get("syncRunId") and row.get("canonicalUrl"):
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
    try:
        fetched = await fetcher(
            url, max_bytes=256_000, timeout=10.0, max_redirects=2,
            allowed_hosts=tuple(sorted(allowed_hosts)),
        )
        if fetched.status != 200 or urlsplit(fetched.url).hostname not in allowed_hosts:
            return excerpt_input
        text = _extract_article_content(
            fetched.content.decode("utf-8", errors="replace"),
            fetched.url,
            source_type,
            max_chars=18_000,
        )
    except Exception as exc:
        logger.warning(
            "radar.score_input_fetch_failed source_type=%s host=%s error_kind=%s",
            source_type, host, type(exc).__name__,
        )
        return excerpt_input
    if not _usable_content(text, source_type=source_type, url=fetched.url):
        return excerpt_input
    return text, "transient_source"


__all__ = ["transient_scoring_input"]
