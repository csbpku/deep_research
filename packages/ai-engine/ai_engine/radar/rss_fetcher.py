"""RSS radar source fetcher using the shared SSRF-safe fetcher."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timezone
from typing import Any

from ai_engine.fetcher.safe_fetch import FetchedDocument, safe_fetch
from ai_engine.ingestion.sources import _parse_rss_xml_simple
from ai_engine.radar.community_fetcher import _is_ai_related
from ai_engine.radar.models import RadarCandidate

SafeFetcher = Callable[..., Awaitable[FetchedDocument]]
DEFAULT_MAX_AGE_HOURS = 24 * 30


def _published_at(raw: str) -> datetime | None:
    if not raw:
        return None
    from email.utils import parsedate_to_datetime

    try:
        return parsedate_to_datetime(raw).astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
        except ValueError:
            return None


async def fetch_rss_candidates(
    config: Mapping[str, Any],
    *,
    fetcher: SafeFetcher = safe_fetch,
    allow_localhost: bool = False,
) -> list[RadarCandidate]:
    """Fetch one configured feed through ``safe_fetch`` and parse RSS items.

    Config keys:
      - ``feedUrl`` (required)
      - ``maxResults`` (default 50, range 1-100)
      - ``maxAgeHours`` (default 720 / 30 days): drop items whose
        ``published_at`` is older than ``now - maxAgeHours``. Items with
        no parseable ``published_at`` are kept (matches kaiye's behavior
        of returning them when cutoff cannot be evaluated). Zero or a
        negative value falls back to the safe 30-day default; a technical
        radar must not silently republish an archive as today's signal.
    """

    feed_url = str(config.get("feedUrl") or "").strip()
    if not feed_url:
        raise ValueError("RSS source requires feedUrl")
    raw_max = config.get("maxResults", 50)
    if isinstance(raw_max, bool):
        raise ValueError("RSS maxResults must be an integer")
    max_results = int(raw_max)
    if max_results < 1 or max_results > 100:
        raise ValueError("RSS maxResults must be between 1 and 100")

    raw_max_age = config.get("maxAgeHours", DEFAULT_MAX_AGE_HOURS)
    if isinstance(raw_max_age, bool):
        raise ValueError("RSS maxAgeHours must be a number")
    hours = float(raw_max_age)
    if hours <= 0:
        hours = DEFAULT_MAX_AGE_HOURS
    if hours > 24 * 365:
        raise ValueError("RSS maxAgeHours must be between 1 and 8760")
    cutoff = datetime.now(timezone.utc).timestamp() - hours * 3600

    # allow_localhost can be set via kwarg or config dict
    allow_local = allow_localhost or bool(config.get("allowLocalhost", False))
    fetch_kwargs: dict[str, Any] = {}
    if allow_local:
        fetch_kwargs["allow_localhost"] = True
        # WeWe-RSS runs on port 4001; allow it
        raw_port = config.get("localPort")
        if raw_port:
            fetch_kwargs["extra_allowed_ports"] = (int(raw_port),)
        else:
            fetch_kwargs["extra_allowed_ports"] = (4001,)
        # WeWe-RSS feeds include full article bodies; can be 30MB+.
        # Raise cap to 32MB to accommodate large feeds.
        fetch_kwargs["max_bytes"] = 32 * 1024 * 1024
    document = await fetcher(feed_url, **fetch_kwargs)
    text = document.content.decode("utf-8", errors="replace")
    items = _parse_rss_xml_simple(text)
    # Source-side AI keyword filter (mirrors agents-radar pattern).
    # Default: ON. Set applyAiFilter=False in config for AI-only feeds
    # (e.g. OpenAI News, Anthropic News, Google AI Blog) to skip the check.
    apply_ai_filter = bool(config.get("applyAiFilter", True))
    candidates: list[RadarCandidate] = []
    for item in items[:max_results]:
        link = item.get("link", "").strip()
        if not link:
            continue
        title = (item.get("title") or "Untitled").strip()[:300]
        description = item.get("description", "").strip()[:2000]
        if apply_ai_filter:
            # Check title + description (case-insensitive regex)
            if not _is_ai_related(f"{title}\n{description}"):
                continue
        published_at = _published_at(item.get("pubDate", "").strip())
        if cutoff is not None and published_at is not None:
            if published_at.timestamp() < cutoff:
                continue
        candidates.append(
            RadarCandidate(
                title=title,
                url=link,
                snippet=description,
                published_at=published_at,
                content_origin="rss",
                tags=("rss",),
                source_quality_hint=0.7,
            )
        )
    return candidates


__all__ = ["fetch_rss_candidates"]
