"""Hugging Face Daily Papers fetcher — feature papers across all HF-curated categories.

Daily Papers is the most authoritative public feed of papers the HF research team has
chosen to highlight that day. It is what every AI newsletter (Latent Space, The Batch,
AlphaSignal) treats as the no-miss signal for new research.

The endpoint returns a list of ~50 JSON objects per day. Each top-level object carries:

    paper:        arXiv-shaped metadata (id, authors, ai_keywords, ai_summary, ...)
    title:        paper title (also available as paper.title)
    publishedAt:  upstream publication timestamp on the paper itself
    submittedOnDailyAt: the day this entry was featured on Daily Papers
    numComments:  engagement signal
    submittedBy:  HF curator user object

We map each item into a RadarCandidate and let the existing arXiv enrichment path pick it
up via ``original_kind="arxiv"`` (HF exposes the arxiv id like '2608.10720').
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from datetime import datetime, timezone
import os
from typing import Any

import httpx

from ai_engine.radar.huggingface import huggingface_endpoint
from ai_engine.radar.models import RadarCandidate



def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        # Accept "...Z" by normalising to "+00:00" before fromisoformat.
        normalized = value.replace("Z", "+00:00") if value.endswith("Z") else value
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _author_names(raw_authors: Any, limit: int = 5) -> str:
    if not isinstance(raw_authors, list):
        return ""
    names: list[str] = []
    for entry in raw_authors:
        if isinstance(entry, dict):
            name = entry.get("name") or entry.get("fullname") or ""
            if isinstance(name, str) and name and name not in names:
                names.append(name)
        elif isinstance(entry, str) and entry and entry not in names:
            names.append(entry)
        if len(names) >= limit:
            break
    return ", ".join(names)


def _timeout_seconds(config: Mapping[str, Any], default: float = 30.0) -> float:
    raw = config.get("timeoutSeconds", os.environ.get("HUGGINGFACE_TIMEOUT_SECONDS", default))
    try:
        return max(5.0, min(120.0, float(raw)))
    except (TypeError, ValueError):
        return default


def _retry_count(config: Mapping[str, Any]) -> int:
    raw = config.get("retries", os.environ.get("HUGGINGFACE_FETCH_RETRIES", "2"))
    try:
        return max(0, min(4, int(raw)))
    except (TypeError, ValueError):
        return 2


async def _get_daily_papers(
    http: httpx.AsyncClient,
    *,
    params: Mapping[str, Any],
    timeout: float,
    retries: int,
) -> Any:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            resp = await http.get(
                huggingface_endpoint("/api/daily_papers"),
                params=dict(params),
                headers={"User-Agent": "deep-research-radar/0.1"},
                timeout=timeout,
            )
            resp.raise_for_status()
            return resp.json()
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as exc:
            last_error = exc
        except httpx.HTTPStatusError as exc:
            if not (exc.response.status_code == 429 or exc.response.status_code >= 500):
                raise
            last_error = exc
        if attempt < retries:
            await asyncio.sleep(min(3.0, 0.5 * (attempt + 1)))
    if last_error is not None:
        raise last_error
    return []


async def fetch_huggingface_papers(
    config: Mapping[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
    timeout: float = 15.0,
) -> list[RadarCandidate]:
    max_results = max(1, min(50, int(config.get("maxResults", 20))))
    # number_of_papers is HF's own cap; pass it through so admin can request 10 / 50 / etc.
    hf_cap = max(1, min(50, int(config.get("number_of_papers", max_results))))
    max_age_hours = max(1, int(config.get("maxAgeHours", 96)))
    min_keywords = max(0, int(config.get("minKeywordOverlap", 0)))
    request_timeout = _timeout_seconds(config, timeout)
    retries = _retry_count(config)

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=request_timeout)
    candidates: list[RadarCandidate] = []

    try:
        data = await _get_daily_papers(
            http,
            params={"number_of_papers": hf_cap},
            timeout=request_timeout,
            retries=retries,
        )
        if not isinstance(data, list):
            return candidates

        now = datetime.now(timezone.utc)
        for item in data:
            if not isinstance(item, dict):
                continue
            paper_raw = item.get("paper")
            paper: dict[str, Any] = paper_raw if isinstance(paper_raw, dict) else {}
            arxiv_id = paper.get("id") or item.get("id") or ""
            if not arxiv_id:
                continue
            title = (item.get("title") or paper.get("title") or arxiv_id).strip()
            url = f"https://huggingface.co/papers/{arxiv_id}"

            published = (
                _parse_iso(paper.get("publishedAt"))
                or _parse_iso(paper.get("submittedOnDailyAt"))
                or _parse_iso(item.get("publishedAt"))
            )
            if published is None:
                published = now
            # Skip papers older than the lookback window — Daily Papers re-serves
            # older items for late visitors and we don't want to re-ingest them.
            age_hours = (now - published).total_seconds() / 3600.0
            if age_hours > max_age_hours:
                continue

            ai_summary = paper.get("ai_summary") or item.get("summary") or ""
            keywords_raw = paper.get("ai_keywords")
            keywords: list[Any] = keywords_raw if isinstance(keywords_raw, list) else []
            if min_keywords and len(keywords) < min_keywords:
                continue

            authors = _author_names(paper.get("authors"))
            github_repo_raw = paper.get("githubRepo")
            github_repo = github_repo_raw if isinstance(github_repo_raw, str) else ""
            stars_raw = paper.get("githubStars")
            github_stars = stars_raw if isinstance(stars_raw, (int, float)) else 0

            snippet_parts: list[str] = []
            if authors:
                snippet_parts.append(f"Authors: {authors}")
            if ai_summary:
                snippet_parts.append(str(ai_summary)[:1200])
            if keywords:
                snippet_parts.append(
                    f"AI keywords: {', '.join(str(k) for k in keywords[:6])}"
                )
            if github_repo:
                snippet_parts.append(f"Code: {github_repo} (⭐ {github_stars})")
            snippet = "\n".join(snippet_parts)[:2000]

            tags = ["huggingface", "daily_papers", "arxiv", "paper"]
            for kw in keywords[:3]:
                if isinstance(kw, str) and kw:
                    tags.append(kw.lower().replace(" ", "_"))

            candidates.append(RadarCandidate(
                title=title[:300],
                url=url,
                snippet=snippet,
                published_at=published,
                content_origin="api",
                tags=tuple(tags),
                source_quality_hint=0.90,  # HF curators pre-filter; bias high
            ))
    finally:
        if owns_client:
            await http.aclose()

    # Preserve HF's own ordering (newest featured first); cap to max_results.
    return candidates[:max_results]
