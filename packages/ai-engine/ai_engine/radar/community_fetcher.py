"""Community radar source fetchers — Hacker News, Reddit, Lobste.rs, Dev.to."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

# ── Hacker News (Algolia Search API) ──

_HN_ALGOLIA_BASE = "https://hn.algolia.com/api/v1"
_HN_QUERIES = ["front_page", "show_hn", "ask_hn", "best"]
_HN_TAG_MAP: dict[str, tuple[str, ...]] = {
    "front_page": ("hackernews", "frontpage"),
    "show_hn": ("hackernews", "show"),
    "ask_hn": ("hackernews", "ask"),
    "best": ("hackernews", "best"),
}


async def fetch_hackernews_candidates(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    queries = list(config.get("queries", _HN_QUERIES))
    max_per_query = max(1, min(30, int(config.get("max_per_query", 8))))
    max_age_hours = float(config.get("max_age_hours", 48.0))
    cutoff_ts = datetime.now(timezone.utc).timestamp() - max_age_hours * 3600

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=10.0)
    candidates: list[RadarCandidate] = []
    seen_urls: set[str] = set()

    try:
        for qname in queries:
            tag = qname.replace("_", "_")
            url = f"{_HN_ALGOLIA_BASE}/search?tags={tag}&hitsPerPage={max_per_query}"
            try:
                resp = await http.get(url)
                resp.raise_for_status()
                data = resp.json()
            except Exception:
                continue
            hits = data.get("hits", []) if isinstance(data, dict) else []
            for hit in hits[:max_per_query]:
                if not isinstance(hit, dict):
                    continue
                item_url = hit.get("url") or hit.get("story_url") or ""
                if not item_url or item_url in seen_urls:
                    continue
                seen_urls.add(item_url)
                created_at = hit.get("created_at")
                published = None
                if isinstance(created_at, str):
                    try:
                        dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                        if dt.timestamp() < cutoff_ts:
                            continue
                        published = dt
                    except ValueError:
                        pass
                title = (hit.get("title") or "").strip()[:300]
                if not title:
                    continue
                points = int(hit.get("points") or 0)
                author = str(hit.get("author") or "")
                snippet = f"HN points: {points} | by {author}" if author else f"HN points: {points}"
                candidates.append(RadarCandidate(
                    title=title, url=item_url, snippet=snippet[:500],
                    published_at=published, content_origin="api",
                    tags=_HN_TAG_MAP.get(qname, ("hackernews",)),
                    source_quality_hint=0.85,
                ))
    finally:
        if owns_client:
            await http.aclose()
    return candidates


# ── Reddit (JSON API with RSS fallback) ──

_REDDIT_BASE = "https://www.reddit.com/r"
_DEFAULT_REDDIT_SUBS = ["programming", "MachineLearning", "LocalLLaMA"]
_REDDIT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def _parse_reddit_rss(xml_text: str, sub: str, max_per: int, cutoff_ts: float) -> list[RadarCandidate]:
    import re as _re
    from email.utils import parsedate_to_datetime
    candidates: list[RadarCandidate] = []
    entries = _re.findall(r"<entry>(.*?)</entry>", xml_text, _re.DOTALL)
    if not entries:
        entries = _re.findall(r"<item>(.*?)</item>", xml_text, _re.DOTALL)
    for entry in entries[:max_per]:
        title_m = _re.search(r"<title>(.*?)</title>", entry, _re.DOTALL)
        link_m = _re.search(r'<link[^>]*href="([^"]+)"', entry) or _re.search(r"<link>(.*?)</link>", entry, _re.DOTALL)
        published_m = _re.search(r"<published>(.*?)</published>", entry) or _re.search(r"<pubDate>(.*?)</pubDate>", entry, _re.DOTALL)
        title = (title_m.group(1) if title_m else "").strip()[:300]
        if not title:
            continue
        item_url = (link_m.group(1) if link_m else "").strip()
        if not item_url:
            continue
        published = None
        if published_m:
            raw_date = published_m.group(1).strip()
            try:
                published = parsedate_to_datetime(raw_date).astimezone(timezone.utc)
            except (TypeError, ValueError, OverflowError):
                try:
                    published = datetime.fromisoformat(raw_date.replace("Z", "+00:00")).astimezone(timezone.utc)
                except ValueError:
                    pass
        if published and published.timestamp() < cutoff_ts:
            continue
        candidates.append(RadarCandidate(
            title=title, url=item_url,
            snippet=f"Reddit r/{sub}",
            published_at=published, content_origin="rss",
            tags=("reddit", f"r/{sub}"),
            source_quality_hint=0.75,
        ))
    return candidates


async def fetch_reddit_candidates(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    subreddits = list(config.get("subreddits", _DEFAULT_REDDIT_SUBS))
    max_per = max(1, min(25, int(config.get("max_per_subreddit", 10))))
    max_age_hours = float(config.get("max_age_hours", 48.0))
    cutoff_ts = datetime.now(timezone.utc).timestamp() - max_age_hours * 3600

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=10.0, headers={"User-Agent": _REDDIT_UA})
    candidates: list[RadarCandidate] = []
    seen_urls: set[str] = set()

    try:
        for sub in subreddits:
            used_rss = False
            try:
                url = f"{_REDDIT_BASE}/{sub}/hot.json?limit={max_per}&raw_json=1"
                resp = await http.get(url)
                resp.raise_for_status()
                data = resp.json()
            except Exception:
                try:
                    rss_url = f"{_REDDIT_BASE}/{sub}/.rss"
                    rss_resp = await http.get(rss_url)
                    rss_resp.raise_for_status()
                    sub_candidates = _parse_reddit_rss(rss_resp.text, sub, max_per, cutoff_ts)
                    for c in sub_candidates:
                        if c.url not in seen_urls:
                            seen_urls.add(c.url)
                            candidates.append(c)
                    used_rss = True
                except Exception:
                    pass
                await asyncio.sleep(2)
                continue
            if used_rss:
                continue
            children = data.get("data", {}).get("children", []) if isinstance(data, dict) else []
            for child in children[:max_per]:
                item = child.get("data", {}) if isinstance(child, dict) else {}
                if not isinstance(item, dict) or item.get("stickied"):
                    continue
                title = (item.get("title") or "").strip()[:300]
                if not title:
                    continue
                created = item.get("created_utc")
                published = None
                if isinstance(created, (int, float)):
                    dt = datetime.fromtimestamp(created, tz=timezone.utc)
                    if dt.timestamp() < cutoff_ts:
                        continue
                    published = dt
                item_url = (item.get("url") or "").strip()
                if not item_url or item_url in seen_urls:
                    item_url = f"https://www.reddit.com{item.get('permalink', '')}"
                if item_url in seen_urls:
                    continue
                seen_urls.add(item_url)
                score = int(item.get("score") or 0)
                comments = int(item.get("num_comments") or 0)
                snippet = f"Reddit r/{sub} | score: {score} | comments: {comments}"
                candidates.append(RadarCandidate(
                    title=title, url=item_url, snippet=snippet,
                    published_at=published, content_origin="api",
                    tags=("reddit", f"r/{sub}"),
                    source_quality_hint=0.75,
                ))
            await asyncio.sleep(2)
    finally:
        if owns_client:
            await http.aclose()
    return candidates


# ── Lobste.rs (tag-based JSON endpoints) ──

_LOBSTERS_TAG_URLS = ("https://lobste.rs/t/ai.json", "https://lobste.rs/t/ml.json")


async def fetch_lobsters_candidates(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    max_results = max(1, min(50, int(config.get("max_results", 20))))
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=10.0)
    candidates: list[RadarCandidate] = []
    seen_urls: set[str] = set()

    try:
        for tag_url in _LOBSTERS_TAG_URLS:
            try:
                resp = await http.get(tag_url)
                resp.raise_for_status()
                data = resp.json()
            except Exception:
                continue
            if not isinstance(data, list):
                continue
            for item in data:
                if not isinstance(item, dict):
                    continue
                item_url = (item.get("url") or item.get("comments_url") or "").strip()
                if not item_url or item_url in seen_urls:
                    continue
                seen_urls.add(item_url)
                title = (item.get("title") or "").strip()[:300]
                if not title:
                    continue
                created_at = item.get("created_at")
                published = None
                if isinstance(created_at, str):
                    try:
                        published = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                    except ValueError:
                        pass
                score = int(item.get("score") or 0)
                comments = int(item.get("comment_count") or 0)
                author = ""
                submitter = item.get("submitter_user")
                if isinstance(submitter, dict):
                    author = str(submitter.get("username", ""))
                snippet = f"Lobste.rs score: {score} | comments: {comments}"
                if author:
                    snippet += f" | by {author}"
                tags_list: list[str] = ["lobsters"]
                raw_tags = item.get("tags")
                if isinstance(raw_tags, list):
                    tags_list.extend(str(t) for t in raw_tags if isinstance(t, str))
                candidates.append(RadarCandidate(
                    title=title, url=item_url, snippet=snippet[:500],
                    published_at=published, content_origin="api",
                    tags=tuple(tags_list), source_quality_hint=0.85,
                ))
                if len(candidates) >= max_results:
                    break
            if len(candidates) >= max_results:
                break
    except Exception:
        pass
    finally:
        if owns_client:
            await http.aclose()
    return candidates


# ── Dev.to (5 tag queries in parallel) ──

_DEVTO_TAGS = ("ai", "llm", "machinelearning", "openai", "langchain")


async def fetch_devto_candidates(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    max_results = max(1, min(30, int(config.get("max_results", 15))))
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "deep-research-radar/0.1"})
    candidates: list[RadarCandidate] = []
    seen_urls: set[str] = set()

    try:
        for tag in _DEVTO_TAGS:
            try:
                url = f"https://dev.to/api/articles?tag={tag}&per_page=30&top=1"
                resp = await http.get(url)
                resp.raise_for_status()
                data = resp.json()
            except Exception:
                continue
            if not isinstance(data, list):
                continue
            for item in data:
                if not isinstance(item, dict):
                    continue
                item_url = (item.get("url") or "").strip()
                if not item_url or item_url in seen_urls:
                    continue
                seen_urls.add(item_url)
                title = (item.get("title") or "").strip()[:300]
                if not title:
                    continue
                pub_str = item.get("published_at")
                published = None
                if isinstance(pub_str, str):
                    try:
                        published = datetime.fromisoformat(pub_str.replace("Z", "+00:00"))
                    except ValueError:
                        pass
                description = (item.get("description") or "").strip()[:500]
                reactions = int(item.get("positive_reactions_count") or 0)
                comments = int(item.get("comments_count") or 0)
                tags_item = item.get("tag_list", [])
                tags_tuple: tuple[str, ...] = ("devto",)
                if isinstance(tags_item, list):
                    tags_tuple = ("devto",) + tuple(str(t).lower() for t in tags_item if isinstance(t, str))
                snippet = description
                if reactions or comments:
                    snippet = f"{description} · reactions: {reactions} · comments: {comments}"
                candidates.append(RadarCandidate(
                    title=title, url=item_url,
                    snippet=snippet[:500] or "Dev.to article",
                    published_at=published, content_origin="api",
                    tags=tags_tuple, source_quality_hint=0.7,
                ))
                if len(candidates) >= max_results:
                    break
            if len(candidates) >= max_results:
                break
    except Exception:
        pass
    finally:
        if owns_client:
            await http.aclose()
    return candidates
