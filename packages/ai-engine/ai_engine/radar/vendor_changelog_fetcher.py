"""Vendor changelog fetcher — tracks API release notes.

Distinct from vendor_news (which polls marketing blogs). Changelogs are
engineer-facing diff logs that surface deprecations, model version bumps,
and breaking parameter changes. We poll each vendor's
``changelog.json`` when available (the structured path) and otherwise
fall back to scraping the index page via SSRF-safe fetch + a small HTML
strip pass.

For each vendor we are given:
    vendor         identifier (e.g. "openai", "anthropic")
    sources        list of URLs to try in order; first one that returns
                   a parseable changelog/JSON/RSS wins.
    title_pattern  regex to extract individual entry titles from a
                   changelog page; the first captured group becomes the
                   candidate title.
    allow_path_regex  optional regex; only entries whose URL matches
                       get ingested (filters out random marketing posts).

The fetcher keys its statefile per vendor so a release on one vendor
doesn't poison another.
"""

from __future__ import annotations

import json
import html as _html
import logging
import os
import re as _re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx

from ai_engine.radar.models import RadarCandidate

logger = logging.getLogger("vendor_changelog_fetcher")

_MAX_ENTRIES_PER_VENDOR = 30
_USER_AGENT = "deep-research-radar/0.1"


@dataclass(frozen=True)
class _ChangelogEntry:
    slug: str
    title: str
    url: str | None = None
    published_at: datetime | None = None


def _state_path() -> Path:
    default = Path(__file__).parent.parent / "static_docs" / ".vendor_changelog_state.json"
    return Path(os.environ.get("VENDOR_CHANGELOG_STATE_PATH", str(default)))


def _load_state() -> dict[str, list[str]]:
    path = _state_path()
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _save_state(state: dict[str, list[str]]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(path)


def _strip_html(html: str) -> str:
    """Cheap HTML strip — sufficient for changelog entry bodies."""
    text = _re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=_re.DOTALL)
    text = _re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=_re.DOTALL)
    text = _re.sub(r"<[^>]+>", " ", text)
    return _re.sub(r"\s+", " ", _html.unescape(text)).strip()


def _extract_block(block: str) -> str:
    """Strip all tags/whitespace from an HTML block.

    Vendor changelog pages often nest the actual entry title inside a header
    like ``<h2><div id="claude-opus-5"><span class="icon"/>Claude Opus 5</span></div></h2>``.
    The simpler ``<h2[^>]*>(.*?)</h2>`` regex captures the inner HTML; we strip
    tags here to surface the visible title.
    """
    return _strip_html(block)


async def _extract_anchors(html: str, source_url: str) -> list[tuple[str, str]]:
    """Pull (slug, title) pairs from a vendor changelog HTML.

    Strategy: find every heading (`<h2>` … `<h6>`) and look INSIDE the
    captured block for an ``id="…"`` attribute whose value looks like an
    anchor slug. The visible text inside the heading becomes the title.
    Falls back to title-pattern matching when no anchor id is present.
    """
    out: list[tuple[str, str]] = []
    seen_slugs: set[str] = set()
    for match in _re.finditer(
        r"<h([1-6])\b[^>]*>(.*?)</h\1>", html, _re.DOTALL
    ):
        block = match.group(2)
        title = _extract_block(block)
        if len(title) < 5:
            continue
        anchor_match = _re.search(
            r'id="([^"]+)"', block
        )
        slug = anchor_match.group(1) if anchor_match else _re.sub(
            r"[^a-z0-9]+", "-", title.lower()
        ).strip("-")[:60]
        if not slug or slug in seen_slugs:
            continue
        seen_slugs.add(slug)
        out.append((slug, title[:240]))
    return out


def _slugify(value: str) -> str:
    return _re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:80] or "entry"


def _parse_rss_datetime(value: str) -> datetime | None:
    try:
        return parsedate_to_datetime(value).astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def _rss_field(block: str, field: str) -> str:
    match = _re.search(rf"<{field}\b[^>]*>(.*?)</{field}>", block, _re.DOTALL | _re.IGNORECASE)
    if not match:
        return ""
    value = match.group(1).strip()
    if value.startswith("<![CDATA[") and value.endswith("]]>"):
        value = value[9:-3]
    return _strip_html(value)


def _extract_rss_entries(html: str, source_url: str) -> list[_ChangelogEntry]:
    """Extract official RSS release-note items without scraping navigation."""
    entries: list[_ChangelogEntry] = []
    for match in _re.finditer(r"<item\b[^>]*>(.*?)</item>", html, _re.DOTALL | _re.IGNORECASE):
        block = match.group(1)
        title = _rss_field(block, "title")
        link = _rss_field(block, "link")
        if len(title) < 5 or not link:
            continue
        url = urljoin(source_url, link)
        entries.append(
            _ChangelogEntry(
                slug=_slugify(url.rsplit("#", 1)[-1] or title),
                title=title[:240],
                url=url,
                published_at=_parse_rss_datetime(_rss_field(block, "pubDate")),
            )
        )
    return entries


def _parse_openai_date(section: str, badge: str) -> datetime | None:
    month_match = _re.search(r"([A-Za-z]+),\s*(\d{4})", section)
    day_match = _re.search(r"([A-Za-z]{3})\s+(\d{1,2})", badge)
    if not month_match or not day_match:
        return None
    months = {
        "january": 1,
        "february": 2,
        "march": 3,
        "april": 4,
        "may": 5,
        "june": 6,
        "july": 7,
        "august": 8,
        "september": 9,
        "october": 10,
        "november": 11,
        "december": 12,
    }
    month = months.get(month_match.group(1).lower())
    if month is None:
        return None
    try:
        return datetime(
            int(month_match.group(2)),
            month,
            int(day_match.group(2)),
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None


def _extract_openai_entries(html: str, source_url: str) -> list[_ChangelogEntry]:
    """Extract entries from OpenAI's current date/badge/markdown layout.

    The current page has no entry heading or per-entry URL. The stable
    ``ChangelogMarkdown`` marker identifies the content cards, while the
    surrounding section and date badge provide a deterministic identity.
    """
    marker_re = _re.compile(
        r'<div\b[^>]*class=["\'][^"\']*ChangelogMarkdown[^"\']*["\'][^>]*>(.*?)</div>',
        _re.DOTALL | _re.IGNORECASE,
    )
    section_re = _re.compile(
        r'<h3\b[^>]*class=["\'][^"\']*ChangelogSectionTitle[^"\']*["\'][^>]*>(.*?)</h3>',
        _re.DOTALL | _re.IGNORECASE,
    )
    badge_re = _re.compile(
        r'<div\b[^>]*class=["\'][^"\']*Badge[^"\']*["\'][^>]*>([A-Za-z]{3}\s+\d{1,2})</div>',
        _re.DOTALL | _re.IGNORECASE,
    )
    entries: list[_ChangelogEntry] = []
    for match in marker_re.finditer(html):
        body = _strip_html(match.group(1))
        if len(body) < 10:
            continue
        prefix = html[:match.start()]
        sections = list(section_re.finditer(prefix))
        section = _strip_html(sections[-1].group(1)) if sections else ""
        badges = list(badge_re.finditer(prefix[-2500:]))
        badge = badges[-1].group(1) if badges else ""
        published_at = _parse_openai_date(section, badge)
        identity = f"{section} {badge} {body}"
        slug = _slugify(identity)
        entries.append(
            _ChangelogEntry(
                slug=slug,
                title=body[:240],
                url=f"{source_url.rstrip('/')}#{slug}",
                published_at=published_at,
            )
        )
    return entries


def _extract_card_entries(html: str, source_url: str) -> list[_ChangelogEntry]:
    """Extract release-note cards such as Anthropic's model index."""
    card_re = _re.compile(
        r'<div\b(?=[^>]*\bdata-cds=["\']Card["\'])(?=[^>]*\bid=["\']([^"\']+)["\'])[^>]*>',
        _re.DOTALL | _re.IGNORECASE,
    )
    starts = list(card_re.finditer(html))
    entries: list[_ChangelogEntry] = []
    for index, match in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else len(html)
        block = html[match.start():end]
        link_match = _re.search(
            r'<a\b[^>]*href=["\']([^"\']*/release-notes/[^"\']*)["\'][^>]*>(.*?)</a>',
            block,
            _re.DOTALL | _re.IGNORECASE,
        )
        if not link_match:
            continue
        title = _strip_html(link_match.group(2))
        if len(title) < 5:
            continue
        entries.append(
            _ChangelogEntry(
                slug=match.group(1),
                title=title[:240],
                url=urljoin(source_url, link_match.group(1)),
            )
        )
    return entries


def _extract_structured_entries(html: str, source_url: str) -> list[_ChangelogEntry]:
    entries = _extract_rss_entries(html, source_url)
    if entries:
        return entries
    entries = _extract_openai_entries(html, source_url)
    if entries:
        return entries
    entries = _extract_card_entries(html, source_url)
    if entries:
        return entries
    return []


async def fetch_vendor_changelog(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    """Fetch one vendor's changelog and return newly-added entries as RadarCandidates."""

    vendor = str(config.get("vendor") or "").strip()
    sources = [str(u) for u in config.get("sources", []) if isinstance(u, str) and u]
    allow_path_regex = config.get("allow_path_regex")
    if not vendor or not sources:
        return []

    title_pattern = config.get("title_pattern")
    if isinstance(title_pattern, str) and title_pattern:
        legacy_title_re = _re.compile(title_pattern, _re.DOTALL)
    else:
        legacy_title_re = None
    path_re = _re.compile(allow_path_regex) if isinstance(allow_path_regex, str) and allow_path_regex else None
    max_entries = max(1, min(60, int(config.get("max_entries", 30))))

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=15.0, headers={"User-Agent": _USER_AGENT}, follow_redirects=True)
    candidates: list[RadarCandidate] = []
    state = _load_state()
    seen_urls: set[str] = set(state.get(vendor, []))

    try:
        for source_url in sources:
            try:
                resp = await http.get(source_url)
                resp.raise_for_status()
                html = resp.text
            except Exception as exc:
                logger.debug(
                    "vendor_changelog.skip_source",
                    extra={"vendor": vendor, "source": source_url, "error": str(exc)},
                )
                continue

            # Prefer source-native structured entries. The legacy heading
            # parser remains a compatibility fallback for older vendor pages
            # and existing seed rows.
            structured_entries = _extract_structured_entries(html, source_url)
            entries: list[_ChangelogEntry] = structured_entries
            if not entries:
                entries = [
                    _ChangelogEntry(slug=slug, title=title)
                    for slug, title in await _extract_anchors(html, source_url)
                ]
            if not entries:
                for m in legacy_title_re.finditer(html) if legacy_title_re else []:
                    title = _strip_html(m.group(1))
                    if 5 <= len(title) <= 240:
                        entries.append(_ChangelogEntry(slug=_slugify(title), title=title))

            for entry in entries:
                slug = entry.slug
                title = entry.title
                url = entry.url or f"{source_url.rstrip('/')}#{slug}"
                if path_re and not path_re.search(url):
                    continue
                if url in seen_urls:
                    continue
                seen_urls.add(url)

                tags = ("vendor_changelog", vendor)
                candidates.append(RadarCandidate(
                    title=title[:300],
                    url=url,
                    snippet="",
                    published_at=entry.published_at or datetime.now(timezone.utc),
                    content_origin="web",
                    tags=tags,
                    source_quality_hint=0.85,
                ))
                if len(candidates) >= max_entries:
                    break

            # If we got any candidates from this source, no need to try fallbacks.
            if candidates:
                break
    finally:
        if owns_client:
            await http.aclose()

    # Persist the bumped state set so the next run can diff against it.
    state[vendor] = sorted(seen_urls)
    _save_state(state)
    return candidates[:_MAX_ENTRIES_PER_VENDOR]
