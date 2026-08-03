"""Community radar source fetchers -- Hacker News, Reddit, Lobste.rs, Dev.to."""

from __future__ import annotations

import asyncio
import re
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

import httpx

from ai_engine.radar.models import RadarCandidate

# AI keyword filter (source-side, mirrors agents-radar/src/hn.ts).
# Used by HN/Reddit/Dev.to fetchers to drop obviously-non-AI items at fetch
# time. Lobste.rs already pulls only t/ai + t/ml tag pages -- it does not
# filter here.

_AI_KEYWORD_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bai\b",
        r"\ba\.i\.\b",
        r"\bllm(s)?\b",
        r"\bml\b",
        r"\bmachine learning\b",
        r"\bdeep learning\b",
        r"\bneural\b",
        r"\btransformer(s)?\b",
        r"\blanguage model(s)?\b",
        r"\bfoundation model(s)?\b",
        r"\brag\b",
        r"\bagent(s|ic)?\b",
        r"\bopenai\b",
        r"\banthropic\b",
        r"\bclaude\b",
        r"\bchatgpt\b",
        r"\bgemini\b",
        r"\bminimax\b",
        r"\bgrok\b",
        r"\bdeepseek\b",
        r"\bkimi\b",
        r"\bqwen\b",
        r"\bcopilot\b",
        r"\bhugging ?face\b",
        r"\blangchain\b",
        r"\blanggraph\b",
        r"\bllamaindex\b",
        r"\bvector (db|database|store)\b",
        r"\bembedding(s)?\b",
        r"\bfine[- ]tune(d|ing)?\b",
        r"\binference\b",
        r"\bprompt\b",
        r"\brlhf\b",
        r"\balignment\b",
        r"\bagentic\b",
        r"\bmcp\b",
        r"\bmodel context protocol\b",
        r"\bvibe coding\b",
        r"\b人工智能\b",
        r"\b大模型\b",
        r"\b智能体\b",
        r"\b微调\b",
        r"\b向量(数据库|检索)\b",
    )
)


def _is_ai_related(corpus: str) -> bool:
    """Return True if any AI keyword pattern matches ``corpus`` (case-insensitive)."""
    if not corpus:
        return False
    for pat in _AI_KEYWORD_PATTERNS:
        if pat.search(corpus):
            return True
    return False


# ── Hacker News (official Firebase API, mirrors agents-radar/src/hn.ts) ──

_HN_TOPSTORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json"
_HN_ITEM_URL = "https://hacker-news.firebaseio.com/v0/item/{item_id}.json"
_HN_STORIES_TO_SCAN = 500
_HN_BATCH_SIZE = 50


async def fetch_hackernews_candidates(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    max_results = max(1, min(30, int(config.get("max_results", 30))))
    scan_size = max(1, min(_HN_STORIES_TO_SCAN, int(config.get("scan_size", _HN_STORIES_TO_SCAN))))
    max_age_hours = float(config.get("max_age_hours", 0))
    cutoff_ts = (
        datetime.now(timezone.utc).timestamp() - max_age_hours * 3600
        if max_age_hours > 0
        else None
    )

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=10.0)
    candidates: list[RadarCandidate] = []

    try:
        resp = await http.get(_HN_TOPSTORIES_URL)
        resp.raise_for_status()
        raw_ids = resp.json()
        if not isinstance(raw_ids, list):
            return candidates
        top_ids = [
            int(item_id)
            for item_id in raw_ids[:scan_size]
            if isinstance(item_id, int) or str(item_id).isdigit()
        ]

        for start in range(0, len(top_ids), _HN_BATCH_SIZE):
            batch_ids = top_ids[start:start + _HN_BATCH_SIZE]
            results = await asyncio.gather(
                *(http.get(_HN_ITEM_URL.format(item_id=item_id)) for item_id in batch_ids),
                return_exceptions=True,
            )
            for item_id, result in zip(batch_ids, results):
                if len(candidates) >= max_results:
                    break
                if isinstance(result, BaseException):
                    continue
                try:
                    result.raise_for_status()
                    item = result.json()
                except Exception:
                    continue
                if (
                    not isinstance(item, dict)
                    or item.get("deleted")
                    or item.get("dead")
                    or item.get("type") != "story"
                ):
                    continue
                title = str(item.get("title") or "").strip()[:300]
                if not title:
                    continue
                corpus = f"{title} {item.get('url') or ''}"
                if not _is_ai_related(corpus):
                    continue
                external_url = (item.get("url") or "").strip()
                hn_url = f"https://news.ycombinator.com/item?id={item_id}"
                published = None
                raw_time = item.get("time")
                if isinstance(raw_time, (int, float)):
                    published = datetime.fromtimestamp(raw_time, tz=timezone.utc)
                    if cutoff_ts is not None and published.timestamp() < cutoff_ts:
                        continue
                points = int(item.get("score") or 0)
                comments = int(item.get("descendants") or 0)
                author = str(item.get("by") or "")
                snippet = f"HN points: {points} | comments: {comments}"
                if author:
                    snippet += f" | by {author}"
                candidates.append(RadarCandidate(
                    title=title,
                    url=external_url or hn_url,
                    snippet=snippet[:500],
                    published_at=published,
                    content_origin="api",
                    tags=("hackernews",),
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
        # Source-side AI keyword filter.
        if not _is_ai_related(title):
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
                # Source-side AI keyword filter.
                if not _is_ai_related(title):
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
    max_age_hours = float(config.get("max_age_hours", 168))
    cutoff_ts = datetime.now(timezone.utc).timestamp() - max_age_hours * 3600
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=10.0)
    by_url: dict[str, tuple[RadarCandidate, int]] = {}

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
                if not item_url or item_url in by_url:
                    continue
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
                if not published or published.timestamp() < cutoff_ts:
                    continue
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
                by_url[item_url] = (RadarCandidate(
                    title=title, url=item_url, snippet=snippet[:500],
                    published_at=published, content_origin="api",
                    tags=tuple(tags_list), source_quality_hint=0.85,
                ), score)
    except Exception:
        pass
    finally:
        if owns_client:
            await http.aclose()
    ranked = sorted(by_url.values(), key=lambda pair: pair[1], reverse=True)
    return [candidate for candidate, _ in ranked[:max_results]]


# ── Dev.to (5 tag queries in parallel) ──

_DEVTO_TAGS = ("ai", "llm", "machinelearning", "openai", "langchain")


async def fetch_devto_candidates(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[RadarCandidate]:
    max_results = max(1, min(30, int(config.get("max_results", 30))))
    tags = list(config.get("tags", _DEVTO_TAGS))
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "deep-research-radar/0.1"})
    by_url: dict[str, tuple[RadarCandidate, int]] = {}

    try:
        for tag in tags:
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
                if not item_url or item_url in by_url:
                    continue
                title = (item.get("title") or "").strip()[:300]
                if not title:
                    continue
                # Source-side AI keyword filter (Dev.to tag pages sometimes
                # include non-AI posts tagged programmatically).
                if not _is_ai_related(title):
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
                by_url[item_url] = (RadarCandidate(
                    title=title, url=item_url,
                    snippet=snippet[:500] or "Dev.to article",
                    published_at=published, content_origin="api",
                    tags=tags_tuple, source_quality_hint=0.7,
                ), reactions)
    except Exception:
        pass
    finally:
        if owns_client:
            await http.aclose()
    ranked = sorted(by_url.values(), key=lambda pair: pair[1], reverse=True)
    return [candidate for candidate, _ in ranked[:max_results]]
