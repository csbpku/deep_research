"""RSS radar source fetcher using the shared SSRF-safe fetcher."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timezone
from typing import Any

from ai_engine.fetcher.safe_fetch import FetchedDocument, safe_fetch
from ai_engine.ingestion.sources import _parse_rss_xml_simple
from ai_engine.radar.models import RadarCandidate

SafeFetcher = Callable[..., Awaitable[FetchedDocument]]


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
) -> list[RadarCandidate]:
    """Fetch one configured feed through ``safe_fetch`` and parse RSS items.

    Config keys:
      - ``feedUrl`` (required)
      - ``maxResults`` (default 50, range 1-100)
      - ``maxAgeHours`` (default None = no filter): drop items whose
        ``published_at`` is older than ``now - maxAgeHours``. Items with
        no parseable ``published_at`` are kept (matches kaiye's behavior
        of returning them when cutoff cannot be evaluated).
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

    raw_max_age = config.get("maxAgeHours")
    cutoff = None
    if raw_max_age is not None:
        if isinstance(raw_max_age, bool):
            raise ValueError("RSS maxAgeHours must be a number")
        hours = float(raw_max_age)
        if hours < 0 or hours > 24 * 30:
            raise ValueError("RSS maxAgeHours must be between 0 and 720")
        cutoff = datetime.now(timezone.utc).timestamp() - hours * 3600

    document = await fetcher(feed_url)
    text = document.content.decode("utf-8", errors="replace")
    items = _parse_rss_xml_simple(text)
    candidates: list[RadarCandidate] = []
    for item in items[:max_results]:
        link = item.get("link", "").strip()
        if not link:
            continue
        published_at = _published_at(item.get("pubDate", "").strip())
        if cutoff is not None and published_at is not None:
            if published_at.timestamp() < cutoff:
                continue
        candidates.append(
            RadarCandidate(
                title=(item.get("title") or "Untitled").strip()[:300],
                url=link,
                snippet=item.get("description", "").strip()[:2000],
                published_at=published_at,
                content_origin="rss",
                tags=("rss",),
                source_quality_hint=0.7,
            )
        )
    return candidates


__all__ = ["fetch_rss_candidates"]
