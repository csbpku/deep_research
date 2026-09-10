"""Vendor news fetcher — crawl vendor sites without RSS via sitemap + HTML.

For vendors that don't offer RSS (Anthropic, OpenAI, etc.), we detect new
pages via sitemap lastmod changes and extract article content from HTML.

Supported vendors are loaded from ``configs/vendor_news.yml`` so adding a new
vendor is a YAML edit + a new ``radar_sources`` row, not a code change.
"""

from __future__ import annotations

import logging
import os
import re as _re
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
import yaml  # type: ignore[import-untyped]  # types-PyYAML not in pyproject; OSS dependency only used here

from ai_engine.radar.huggingface import rewrite_huggingface_url
from ai_engine.radar.models import RadarCandidate

logger = logging.getLogger("vendor_news_fetcher")

# Cap on first-run fetch: when no previous state exists, all sitemap URLs
# are "new". Matches agents-radar's MAX_CONTENT_FETCH_FIRST_RUN per site.
_FIRST_RUN_MAX_FETCH = 25
_VENDOR_NEWS_MAX_AGE_HOURS = 72

# Sentinel used to surface misconfiguration early — the YAML must have at
# least these two vendors so existing rows that pre-date this PR don't break.
_REQUIRED_VENDORS: tuple[str, ...] = ("anthropic", "openai")


def _config_path() -> Path:
    """Resolves the vendor YAML; overridable via ``VENDOR_NEWS_CONFIG_PATH``."""
    default = Path(__file__).resolve().parents[2] / "configs" / "vendor_news.yml"
    override = os.environ.get("VENDOR_NEWS_CONFIG_PATH")
    return Path(override) if override else default


@lru_cache(maxsize=1)
def _load_vendor_configs() -> dict[str, dict[str, Any]]:
    """Read ``configs/vendor_news.yml`` once and freeze the result.

    lru_cache keeps this a one-shot disk read per process; admin updates
    require a restart (which is also when they edit the YAML).
    """
    raw = _config_path().read_text(encoding="utf-8")
    payload = yaml.safe_load(raw) or {}
    vendors_raw = payload.get("vendors", {}) if isinstance(payload, dict) else {}
    if not isinstance(vendors_raw, dict):
        raise RuntimeError(
            f"vendor_news.yml: 'vendors' must be a mapping, got {type(vendors_raw).__name__}"
        )
    parsed: dict[str, dict[str, Any]] = {}
    for vendor_key, cfg in vendors_raw.items():
        if not isinstance(cfg, dict):
            logger.warning("vendor_news_skip_invalid_entry", extra={"vendor": vendor_key})
            continue
        sitemap_url = cfg.get("sitemap_url")
        rss_url = cfg.get("rss_url")
        if not sitemap_url and not rss_url:
            logger.warning(
                "vendor_news_missing_source",
                extra={"vendor": vendor_key, "reason": "no sitemap_url or rss_url"},
            )
            continue
        url_pattern = cfg.get("url_pattern", "")
        if not url_pattern:
            logger.warning(
                "vendor_news_missing_pattern",
                extra={"vendor": vendor_key, "reason": "no url_pattern"},
            )
            continue
        tags_value = cfg.get("tags", ("vendor", vendor_key))
        tags = tuple(tags_value) if isinstance(tags_value, list) else (str(tags_value),)
        # The legacy hard-coded config used key 'sitemap_url'; preserve a
        # backwards-compatible fallback so any direct callers passing the
        # old shape still get something.
        parsed[vendor_key] = {
            "name": str(cfg.get("name", vendor_key)),
            "sitemap_url": str(sitemap_url) if sitemap_url else None,
            "rss_url": str(rss_url) if rss_url else None,
            "url_pattern": str(url_pattern),
            "ai_filter": bool(cfg.get("ai_filter", True)),
            "quality_hint": float(cfg.get("quality_hint", 0.8)),
            "tags": tags,
            "max_age_hours": int(cfg.get("max_age_hours", _VENDOR_NEWS_MAX_AGE_HOURS)),
        }
    missing = [v for v in _REQUIRED_VENDORS if v not in parsed]
    if missing:
        raise RuntimeError(
            f"vendor_news.yml is missing required vendors: {missing}. "
            "The legacy Anthropic + OpenAI rows in radar_sources will break."
        )
    return parsed


# Module-level snapshot — refreshed on first call to ``check_and_fetch_vendor_news``.
_VENDOR_CONFIGS: dict[str, dict[str, Any]] = _load_vendor_configs()


def _state_path() -> Path:
    default = Path(__file__).parent.parent / "static_docs" / ".vendor_news_state.json"
    return Path(os.environ.get("VENDOR_NEWS_STATE_PATH", str(default)))


def _load_state() -> dict[str, dict[str, str]]:
    path = _state_path()
    if path.exists():
        try:
            import json
            with open(path) as f:
                return dict(json.load(f))
        except Exception:
            return {}
    return {}


def _save_state(state: dict[str, dict[str, str]]) -> None:
    import json
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    tmp.replace(path)


async def _fetch_sitemap(
    url: str,
    *,
    client: httpx.AsyncClient,
    timeout: float = 15.0,
) -> str:
    resp = await client.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def _vendor_source_url(
    vendor: str | Mapping[str, Any],
    cfg: Mapping[str, Any] | None = None,
) -> str:
    """Pick the actual XML source for a vendor: RSS if available, else sitemap.

    The YAML uses ``rss_url`` for sources that publish a feed (OpenAI, DeepMind,
    Mistral, Hugging Face) and ``sitemap_url`` for HTML-only vendors (Anthropic,
    xAI). The rest of the fetcher treats both as an XML/RSS document to parse.
    """
    # Keep the old one-argument helper shape for scripts/tests that used the
    # fetcher before vendor-specific URL rewriting was introduced.
    if cfg is None:
        cfg = vendor if isinstance(vendor, Mapping) else {}
        vendor_name = ""
    else:
        vendor_name = str(vendor)
    rss = cfg.get("rss_url")
    if isinstance(rss, str) and rss:
        return rewrite_huggingface_url(rss) if vendor_name == "huggingface_blog" else rss
    sitemap = cfg.get("sitemap_url")
    if isinstance(sitemap, str) and sitemap:
        return rewrite_huggingface_url(sitemap) if vendor_name == "huggingface_blog" else sitemap
    raise ValueError(f"vendor config missing rss_url and sitemap_url: {cfg.get('name', '?')}")


def _parse_sitemap(xml: str, url_pattern: str) -> dict[str, str]:
    """Parse sitemap XML or RSS feed, return {url: lastmod} for matching urls.

    Handles three formats:
    - Sitemap index: <sitemap><loc>...</loc></sitemap> → returns empty
      (caller should follow sub-sitemaps; not implemented here)
    - URL sitemap: <url><loc>...</loc><lastmod>...</lastmod></url>
    - RSS feed: <item><link>...</link><pubDate>...</pubDate></item>
    """
    results: dict[str, str] = {}
    pattern = _re.compile(url_pattern)

    # URL sitemap entries
    for match in _re.finditer(
        r"<url>\s*<loc>(.*?)</loc>(?:\s*<lastmod>(.*?)</lastmod>)?",
        xml, _re.DOTALL,
    ):
        url = match.group(1).strip()
        if not pattern.search(url):
            continue
        results[url] = (match.group(2) or "").strip()

    # RSS feed entries (for vendors that offer RSS instead of sitemap)
    for match in _re.finditer(
        r"<item>.*?<link>(.*?)</link>.*?(?:<pubDate>(.*?)</pubDate>)?",
        xml, _re.DOTALL,
    ):
        url = match.group(1).strip()
        if not pattern.search(url):
            continue
        if url not in results:
            results[url] = (match.group(2) or "").strip()

    # Atom feed entries
    for match in _re.finditer(
        r"<entry>.*?<link[^>]*href=\"([^\"]+)\".*?(?:<published>(.*?)</published>)?",
        xml, _re.DOTALL,
    ):
        url = match.group(1).strip()
        if not pattern.search(url):
            continue
        if url not in results:
            results[url] = (match.group(2) or "").strip()

    return results


def _extract_article_text(html: str) -> str:
    """Strip HTML to article text."""
    text = _re.sub(r"<script[^>]*>.*?</script>", "", html, flags=_re.DOTALL)
    text = _re.sub(r"<style[^>]*>.*?</style>", "", text, flags=_re.DOTALL)
    text = _re.sub(r"<nav[^>]*>.*?</nav>", "", text, flags=_re.DOTALL)
    text = _re.sub(r"<footer[^>]*>.*?</footer>", "", text, flags=_re.DOTALL)
    text = _re.sub(r"<[^>]+>", "\n", text)
    text = _re.sub(r"&nbsp;", " ", text)
    text = _re.sub(r"&amp;", "&", text)
    text = _re.sub(r"&lt;", "<", text)
    text = _re.sub(r"&gt;", ">", text)
    text = _re.sub(r"&quot;", '"', text)
    text = _re.sub(r"\n\s*\n", "\n\n", text)
    lines = [line.strip() for line in text.split("\n") if line.strip() and len(line.strip()) > 5]
    return "\n".join(lines)


def _is_protection_shell(text: str) -> bool:
    lowered = " ".join((text or "").split()).lower()
    return any(
        marker in lowered
        for marker in (
            "enable javascript and cookies to continue",
            "checking your browser before accessing",
            "prove your humanity",
            "complete the challenge",
            "attention required! | cloudflare",
            "performance & security by cloudflare",
            "challenge-platform",
            "cf-chl-",
        )
    )


def _parse_rss_items(xml: str) -> dict[str, dict[str, str]]:
    """Parse RSS <item> elements, return {url: {title, description, pubDate}}."""
    results: dict[str, dict[str, str]] = {}
    for match in _re.finditer(r"<item>(.*?)</item>", xml, _re.DOTALL):
        block = match.group(1)
        item: dict[str, str] = {}
        for field in ("title", "link", "description", "pubDate"):
            fm = _re.search(rf"<{field}[^>]*>(.*?)</{field}>", block, _re.DOTALL)
            if fm:
                value = fm.group(1).strip()
                if value.startswith("<![CDATA[") and value.endswith("]]>"):
                    value = value[9:-3]
                item[field] = value
        link = item.get("link", "").strip()
        if link:
            results[link] = item
    return results


def _parse_pubdate_from_rss(xml: str, url: str) -> datetime | None:
    """Extract RFC 822 pubDate for a specific URL from an RSS feed."""
    from email.utils import parsedate_to_datetime
    for match in _re.finditer(r"<item>(.*?)</item>", xml, _re.DOTALL):
        block = match.group(1)
        link_m = _re.search(r"<link[^>]*>(.*?)</link>", block, _re.DOTALL)
        if not link_m:
            continue
        link = link_m.group(1).strip()
        if link.strip("<>\"'") != url:
            continue
        pd_m = _re.search(r"<pubDate[^>]*>(.*?)</pubDate>", block, _re.DOTALL)
        if pd_m:
            try:
                return parsedate_to_datetime(pd_m.group(1).strip())
            except Exception:
                pass
    return None


def _coerce_utc(value: str) -> datetime | None:
    """Parse an ISO sitemap <lastmod> value into an aware UTC datetime."""
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _infer_title(text: str, url: str) -> str:
    lines = text.strip().split("\n")
    for line in lines:
        line = line.strip()
        if line and 5 < len(line) < 200:
            return line[:200]
    path = url.rstrip("/").split("/")[-1]
    return path.replace("-", " ").replace("_", " ").title()[:200]


async def check_and_fetch_vendor_news(
    vendor: str,
    *,
    lookback_hours: int | None = None,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    """Check vendor sitemap for new/updated news pages and fetch them.

    Returns RadarCandidate list for newly detected articles.
    """
    cfg = _VENDOR_CONFIGS.get(vendor)
    if not cfg:
        raise ValueError(f"unknown vendor: {vendor}")

    owns_client = client is None
    http = client or httpx.AsyncClient(
        timeout=15.0,
        headers={"User-Agent": "deep-research-vendor-news/0.1"},
        follow_redirects=True,
    )
    max_age_hours = lookback_hours or int(cfg.get("max_age_hours", _VENDOR_NEWS_MAX_AGE_HOURS))
    request_timeout = 15.0
    if vendor == "huggingface_blog":
        try:
            request_timeout = max(
                5.0,
                min(120.0, float(os.environ.get("HUGGINGFACE_TIMEOUT_SECONDS", "30"))),
            )
        except ValueError:
            request_timeout = 30.0
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
    candidates: list[RadarCandidate] = []

    try:
        # 1. Fetch vendor XML source (RSS if vendor publishes one, else sitemap).
        source_url = _vendor_source_url(vendor, cfg)
        if vendor == "huggingface_blog":
            xml = await _fetch_sitemap(
                source_url,
                client=http,
                timeout=request_timeout,
            )
        else:
            # Keep the original helper call shape for integrations that
            # provide a small test/client adapter around the fetcher.
            xml = await _fetch_sitemap(source_url, client=http)
        current_urls = _parse_sitemap(xml, cfg["url_pattern"])

        # 2. Diff with previous state
        state = _load_state()
        previous = state.get(vendor, {})
        is_first_run = len(previous) == 0
        new_or_changed: list[tuple[str, datetime]] = []
        for url, lastmod in current_urls.items():
            prev = previous.get(url)
            if prev is None or (lastmod and prev != lastmod):
                # Apply the time window using RSS pubDate when present; for
                # sitemap-only vendors fall back to <lastmod> so max_age_hours
                # still bounds what we fetch.
                pub_date = _parse_pubdate_from_rss(xml, url)
                if pub_date is None:
                    pub_date = _coerce_utc(lastmod)
                if pub_date is not None and pub_date < cutoff:
                    continue
                new_or_changed.append((url, pub_date or datetime.now(timezone.utc)))

        # First-run cap: only fetch the N most recent URLs to avoid
        # overwhelming the vendor site and our pipeline on initial setup.
        if is_first_run and len(new_or_changed) > _FIRST_RUN_MAX_FETCH:
            logger.info(
                "vendor_news_first_run_cap",
                extra={
                    "vendor": vendor,
                    "total_new": len(new_or_changed),
                    "capped_to": _FIRST_RUN_MAX_FETCH,
                },
            )
            # Sort by pubDate descending, then take the most recent
            new_or_changed.sort(key=lambda x: x[1], reverse=True)
            new_or_changed = new_or_changed[:_FIRST_RUN_MAX_FETCH]

        # 3. Persist state
        state[vendor] = current_urls
        _save_state(state)

        # 4. Parse RSS metadata for fallback (when HTML pages require JS)
        rss_metadata = _parse_rss_items(xml) if "<item>" in xml else {}

        # 5. Fetch new/changed pages
        for url, pub_dt in new_or_changed:
            try:
                request_url = (
                    rewrite_huggingface_url(url)
                    if vendor == "huggingface_blog"
                    else url
                )
                resp = await http.get(request_url, timeout=request_timeout)
                resp.raise_for_status()
                text = _extract_article_text(resp.text)
                if len(text) < 100 or _is_protection_shell(text):
                    # HTML extraction failed (JS-required pages like OpenAI).
                    # Fall back to RSS <description> if available.
                    meta = rss_metadata.get(url, {})
                    desc = meta.get("description", "").strip()
                    if _is_protection_shell(desc):
                        desc = ""
                    rss_title = meta.get("title", "").strip()
                    if rss_title or desc:
                        title = rss_title or _infer_title(desc, url)
                        snippet = desc[:500] if desc else title
                        candidates.append(RadarCandidate(
                            title=title[:300],
                            url=url,
                            snippet=snippet,
                            published_at=pub_dt,
                            content_origin="web",
                            tags=cfg["tags"],
                            source_quality_hint=cfg["quality_hint"],
                        ))
                    continue
                title = _infer_title(text, url)
                snippet = text[:500].replace("\n", " ")
                candidates.append(RadarCandidate(
                    title=title,
                    url=url,
                    snippet=snippet,
                    published_at=pub_dt,
                    content_origin="web",
                    tags=cfg["tags"],
                    source_quality_hint=cfg["quality_hint"],
                ))
            except Exception as exc:
                # Last resort: use RSS metadata if HTML fetch failed entirely
                meta = rss_metadata.get(url, {})
                rss_title = meta.get("title", "").strip()
                desc = meta.get("description", "").strip()
                if _is_protection_shell(desc):
                    desc = ""
                if rss_title or desc:
                    title = rss_title or _infer_title(desc, url)
                    snippet = desc[:500] if desc else title
                    candidates.append(RadarCandidate(
                        title=title[:300],
                        url=url,
                        snippet=snippet,
                        published_at=pub_dt,
                        content_origin="web",
                        tags=cfg["tags"],
                        source_quality_hint=cfg["quality_hint"],
                    ))
                else:
                    logger.warning("vendor_news_fetch_failed", extra={"url": url, "error": str(exc)})

        logger.info(
            "vendor_news_checked",
            extra={
                "vendor": vendor,
                "total_in_sitemap": len(current_urls),
                "new_or_changed": len(new_or_changed),
                "fetched": len(candidates),
            },
        )
    finally:
        if owns_client:
            await http.aclose()

    return candidates
