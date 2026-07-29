"""Vendor sitemap change detector.

Watches sitemap.xml lastmod timestamps for vendor sites.
When a page's lastmod changes, the URL is marked as "updated"
and can be fetched by vendor_docs_fetcher.py.

Storage uses a state JSON file on disk (no DB dependency).
"""

from __future__ import annotations

import json
import logging
import os
import re as _re
from pathlib import Path

import httpx

logger = logging.getLogger("sitemap_watcher")

_VENDOR_SITEMAPS: dict[str, str] = {
    "claude": "https://platform.claude.com/sitemap.xml",
    "openai": "https://platform.openai.com/sitemap.xml",
}

# Patterns to focus on: docs, guides, cookbooks (skip marketing pages)
_INCLUDE_PATTERNS: list[_re.Pattern[str]] = [
    _re.compile(r"/docs/"),
    _re.compile(r"/guides/"),
    _re.compile(r"/cookbook/"),
    _re.compile(r"/use-case"),
    _re.compile(r"/build-with-claude/"),
    _re.compile(r"/agents-and-tools/"),
    _re.compile(r"/test-and-evaluate/"),
]

_EXCLUDE_PATTERNS: list[_re.Pattern[str]] = [
    _re.compile(r"/api/"),
    _re.compile(r"/release-notes/"),
    _re.compile(r"/changelog"),
    _re.compile(r"/pricing"),
    _re.compile(r"/about"),
    _re.compile(r"/careers"),
    _re.compile(r"/blog/page/"),
]


def _state_path() -> Path:
    """State file: tracks last seen lastmod per URL per vendor."""
    return Path(os.environ.get(
        "SITEMAP_STATE_PATH",
        str(Path(__file__).parent.parent / "static_docs" / ".sitemap_state.json"),
    ))


def _load_state() -> dict[str, dict[str, str]]:
    """Load persisted sitemap state.

    Format: {vendor_name: {url: lastmod_iso_string}}
    """
    path = _state_path()
    if path.exists():
        try:
            with open(path) as f:
                return dict(json.load(f))
        except (json.JSONDecodeError, OSError):
            logger.warning("sitemap_state_corrupt", extra={"path": str(path)})
    return {}


def _save_state(state: dict[str, dict[str, str]]) -> None:
    """Persist sitemap state to disk."""
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    tmp.replace(path)


async def _fetch_sitemap(url: str, *, client: httpx.AsyncClient) -> str:
    resp = await client.get(url, timeout=15.0)
    resp.raise_for_status()
    return resp.text


def _parse_sitemap(
    xml_text: str,
) -> dict[str, str]:
    """Parse sitemap XML into {url: lastmod} mapping.

    Both flat sitemaps and sitemap indexes (nested <sitemap> elements)
    are supported. Returns only URLs matching _INCLUDE_PATTERNS and
    not matching _EXCLUDE_PATTERNS.
    """
    results: dict[str, str] = {}

    # Check if it's a sitemap index first
    index_items = list(_re.finditer(
        r"<sitemap>\s*<loc>(.*?)</loc>(?:\s*<lastmod>(.*?)</lastmod>)?\s*</sitemap>",
        xml_text, _re.DOTALL,
    ))

    if index_items:
        # Sitemap index — fetch each child sitemap
        return results  # Placeholder: caller handles recursion

    # Flat sitemap
    for match in _re.finditer(
        r"<url>\s*<loc>(.*?)</loc>(?:\s*<lastmod>(.*?)</lastmod>)?",
        xml_text, _re.DOTALL,
    ):
        url = match.group(1).strip()
        lastmod_raw = match.group(2)
        lastmod = (lastmod_raw or "").strip()

        # Apply include/exclude filters
        if not any(p.search(url) for p in _INCLUDE_PATTERNS):
            continue
        if any(p.search(url) for p in _EXCLUDE_PATTERNS):
            continue

        results[url] = lastmod

    return results


def _is_relevant_url(url: str) -> bool:
    """Check if a URL is a doc/guide/cookbook page worth fetching."""
    if not any(p.search(url) for p in _INCLUDE_PATTERNS):
        return False
    if any(p.search(url) for p in _EXCLUDE_PATTERNS):
        return False
    return True


async def check_updates(
    vendor: str = "claude",
    sitemap_url: str | None = None,
    *,
    client: httpx.AsyncClient | None = None,
) -> list[dict[str, str]]:
    """Check a vendor sitemap and return URLs that changed since last check.

    Returns list of dicts:
      {"url": ..., "action": "new"|"updated", "title_hint": ...}
    """
    url = sitemap_url or _VENDOR_SITEMAPS.get(vendor)
    if not url:
        raise ValueError(f"unknown vendor: {vendor}")

    owns_client = client is None
    http = client or httpx.AsyncClient(
        timeout=15.0,
        headers={"User-Agent": "deep-research-sitemap-watcher/0.1"},
    )

    try:
        xml_text = await _fetch_sitemap(url, client=http)

        # Check for sitemap index
        if "<sitemapindex" in xml_text or "<sitemap>" in xml_text:
            # Fetch child sitemaps
            child_sitemaps = list(_re.finditer(
                r"<sitemap>\s*<loc>(.*?)</loc>",
                xml_text, _re.DOTALL,
            ))
            current_urls: dict[str, str] = {}
            for child_match in child_sitemaps:
                child_url = child_match.group(1).strip()
                try:
                    child_xml = await http.get(child_url, timeout=15.0)
                    child_xml.raise_for_status()
                    child_parsed = _parse_sitemap(child_xml.text)
                    current_urls.update(child_parsed)
                except Exception:
                    logger.warning("sitemap_child_failed", extra={"url": child_url})
        else:
            current_urls = _parse_sitemap(xml_text)

    finally:
        if owns_client:
            await http.aclose()

    # Load previous state
    state = _load_state()
    previous = state.get(vendor, {})

    # Diff: what's new or changed
    changes: list[dict[str, str]] = []
    for url, lastmod in current_urls.items():
        prev_lastmod = previous.get(url)
        if prev_lastmod is None:
            changes.append({"url": url, "action": "new", "lastmod": lastmod})
        elif prev_lastmod != lastmod:
            changes.append({"url": url, "action": "updated", "lastmod": lastmod})

    # Persist updated state
    state[vendor] = current_urls
    _save_state(state)

    logger.info(
        "sitemap_updates_checked",
        extra={
            "vendor": vendor,
            "total": len(current_urls),
            "changes": len(changes),
        },
    )
    return changes


async def check_all_vendors(
    *,
    client: httpx.AsyncClient | None = None,
) -> dict[str, list[dict[str, str]]]:
    """Check sitemaps for all configured vendors and return changes."""
    all_changes: dict[str, list[dict[str, str]]] = {}
    for vendor, sitemap_url in _VENDOR_SITEMAPS.items():
        try:
            changes = await check_updates(vendor, sitemap_url, client=client)
            if changes:
                all_changes[vendor] = changes
        except Exception as exc:
            logger.warning(
                "sitemap_vendor_failed",
                extra={"vendor": vendor, "error": str(exc)},
            )
    return all_changes


__all__ = ["check_all_vendors", "check_updates"]
