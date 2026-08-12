"""OpenReview fetcher — accepted papers from major ML conferences.

OpenReview hosts the public record for NeurIPS / ICML / ICLR / TMLR submissions,
including accepted papers. The fetcher queries the public ``/notes/search``
endpoint per conference venue group, applies an age gate so we only ingest
papers that look newly accepted, and emits canonical OpenReview forum URLs.

We deliberately stay on the public search API (no API key required) and
respect OpenReview's soft rate limit by capping ``maxResults`` and only
querying venues that the operator enabled in ``radar_sources.config``.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

_OPENREVIEW_SEARCH = "https://api2.openreview.net/notes/search"


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000.0, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _field(content: Mapping[str, Any], *names: str) -> Any:
    """Look up the first non-empty ``content[name].value`` shape."""
    for name in names:
        field = content.get(name)
        if isinstance(field, dict):
            value = field.get("value")
            if value not in (None, "", []):
                return value
        elif field not in (None, "", []):
            return field
    return None


def _author_names(raw: Any, limit: int = 5) -> str:
    if not isinstance(raw, list):
        return ""
    names: list[str] = []
    for entry in raw:
        if isinstance(entry, dict):
            name = entry.get("name") or entry
            if isinstance(name, str) and name and name not in names:
                names.append(name)
        elif isinstance(entry, str) and entry and entry not in names:
            names.append(entry)
        if len(names) >= limit:
            break
    return ", ".join(names)


async def fetch_openreview(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
    timeout: float = 20.0,
) -> list[RadarCandidate]:
    """Query OpenReview for newly accepted papers across configured venues.

    ``config`` schema::

        {
            "venues": [
                "NeurIPS.cc/2024/Conference",
                "ICLR.cc/2025/Conference",
                "ICML.cc/2024/Conference",
            ],
            "query": "<full-text search term applied to all venues>",
            "maxResults": 30,
            "maxAgeDays": 14,
            "limitPerVenue": 30,
        }
    """

    max_results = max(1, min(100, int(config.get("maxResults", 30))))
    max_age_days = max(1, int(config.get("maxAgeDays", 14)))
    limit_per_venue = max(1, min(100, int(config.get("limitPerVenue", 30))))
    query_term = str(config.get("query", "agent").strip() or "agent")
    venues: list[str] = [str(v) for v in config.get("venues", []) if isinstance(v, str) and v]

    if not venues:
        return []

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout)
    candidates: list[RadarCandidate] = []

    try:
        now = datetime.now(timezone.utc)
        for venue in venues:
            submission_inv = f"{venue}/-/Submission"
            try:
                resp = await http.get(
                    _OPENREVIEW_SEARCH,
                    params={
                        "term": query_term,
                        "invitation": submission_inv,
                        "source": "forum",
                        "limit": limit_per_venue,
                    },
                    headers={"User-Agent": "deep-research-radar/0.1"},
                )
            except httpx.HTTPError:
                continue
            if resp.status_code != 200:
                continue
            try:
                payload = resp.json()
            except ValueError:
                continue
            notes = payload.get("notes") if isinstance(payload, dict) else None
            if not isinstance(notes, list):
                continue

            for note in notes:
                if not isinstance(note, dict):
                    continue
                content = note.get("content")
                if not isinstance(content, dict):
                    continue

                title = _field(content, "title")
                abstract = _field(content, "abstract")
                keywords_raw = _field(content, "keywords")
                keywords = (
                    [str(k) for k in keywords_raw if isinstance(k, str)]
                    if isinstance(keywords_raw, list)
                    else []
                )
                venue_label = _field(content, "venue")
                pdf_url = _field(content, "pdf")
                if not isinstance(title, str) or not title.strip():
                    continue
                title = title.strip()[:300]

                forum = note.get("forum") or note.get("id")
                if not isinstance(forum, str) or not forum:
                    continue
                url = f"https://openreview.net/forum?id={forum}"

                # Use OpenReview's pdate (the most recent publication timestamp)
                # to decide whether this counts as "new". Fall back to mdate.
                published = _parse_iso(note.get("pdate")) or _parse_iso(note.get("mdate"))
                if published is not None:
                    age_days = (now - published).days
                    if age_days > max_age_days:
                        continue

                authors = _author_names(_field(content, "authors", "authorids"))

                snippet_parts: list[str] = []
                if authors:
                    snippet_parts.append(f"Authors: {authors}")
                if abstract:
                    snippet_parts.append(str(abstract)[:1200])
                if keywords:
                    snippet_parts.append(f"Keywords: {', '.join(keywords[:8])}")
                if venue_label:
                    snippet_parts.append(f"Venue: {venue_label}")
                if pdf_url:
                    snippet_parts.append(f"PDF: {pdf_url}")
                snippet = "\n".join(snippet_parts)[:2000]

                tags = ["openreview", "paper", "accepted_paper", venue.split("/")[0].lower()]
                for kw in keywords[:3]:
                    if isinstance(kw, str) and kw:
                        tags.append(kw.lower().replace(" ", "_"))

                candidates.append(RadarCandidate(
                    title=title,
                    url=url,
                    snippet=snippet,
                    published_at=published or now,
                    content_origin="api",
                    tags=tuple(tags),
                    source_quality_hint=0.85,  # reviewer-accepted papers; bias high
                ))
    finally:
        if owns_client:
            await http.aclose()

    # Preserve OpenReview's per-venue relevance ordering but cap the total.
    return candidates[:max_results]
