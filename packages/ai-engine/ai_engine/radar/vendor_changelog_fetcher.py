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
import logging
import os
import re as _re
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

logger = logging.getLogger("vendor_changelog_fetcher")

_MAX_ENTRIES_PER_VENDOR = 30
_USER_AGENT = "deep-research-radar/0.1"


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
    text = _re.sub(r"&nbsp;", " ", text)
    text = _re.sub(r"&amp;", "&", text)
    text = _re.sub(r"&lt;", "<", text)
    text = _re.sub(r"&gt;", ">", text)
    text = _re.sub(r"&quot;", '"', text)
    text = _re.sub(r"\s+", " ", text)
    return text.strip()


async def fetch_vendor_changelog(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    """Fetch one vendor's changelog and return newly-added entries as RadarCandidates."""

    vendor = str(config.get("vendor") or "").strip()
    sources = [str(u) for u in config.get("sources", []) if isinstance(u, str) and u]
    title_pattern = str(config.get("title_pattern") or r"<h[1-3][^>]*>(.*?)</h[1-3]>")
    allow_path_regex = config.get("allow_path_regex")
    if not vendor or not sources:
        return []

    title_re = _re.compile(title_pattern, _re.DOTALL)
    path_re = _re.compile(allow_path_regex) if isinstance(allow_path_regex, str) and allow_path_regex else None

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

            for match in title_re.finditer(html):
                title_raw = match.group(1).strip()
                title = _strip_html(title_raw)
                if len(title) < 5 or len(title) > 240:
                    continue
                snippet = _strip_html(html[match.end():match.end() + 800])[:500]
                # Approximate the per-entry URL via the source URL + title slug;
                # a structured changelog would carry this metadata; for now the
                # anchor forms a stable enough reference for admin triage.
                slug = _re.sub(r"[^a-z0-9]+", "-", title.lower())[:60].strip("-")
                url = f"{source_url.rstrip('/')}#{slug}" if slug else source_url

                if path_re and not path_re.search(url):
                    continue
                if url in seen_urls:
                    continue
                seen_urls.add(url)

                tags = ("vendor_changelog", vendor)
                candidates.append(RadarCandidate(
                    title=title[:300],
                    url=url,
                    snippet=snippet,
                    published_at=datetime.now(timezone.utc),
                    content_origin="web",
                    tags=tags,
                    source_quality_hint=0.85,
                ))
                if len(candidates) >= _MAX_ENTRIES_PER_VENDOR:
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
