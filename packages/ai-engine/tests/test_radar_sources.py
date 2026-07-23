from __future__ import annotations

import socket
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest

from ai_engine.fetcher.safe_fetch import FetchedDocument, SafeFetchError
from ai_engine.radar.arxiv_fetcher import fetch_arxiv_candidates
from ai_engine.radar.github import fetch_github
from ai_engine.radar.models import RadarCandidate, RadarSource
from ai_engine.radar.pipeline import normalize_candidate, score_candidate
from ai_engine.radar.rss_fetcher import fetch_rss_candidates
from ai_engine.radar.source_manager import fetch_source


RSS_XML = b"""<?xml version="1.0"?><rss><channel><item>
<title>Agent release</title><link>https://example.com/agent</link>
<description>LLM agent update</description><pubDate>Wed, 22 Jul 2026 12:00:00 GMT</pubDate>
</item></channel></rss>"""


def _doc(content: bytes = RSS_XML, *, url: str = "https://feed.example/rss") -> FetchedDocument:
    return FetchedDocument(
        url=url,
        final_ip="93.184.216.34",
        status=200,
        headers={"content-type": "application/rss+xml"},
        content=content,
        content_type="application/rss+xml",
        elapsed_ms=7,
        redirect_count=0,
    )


def test_normalize_candidate_uses_shared_canonicalizer() -> None:
    normalized = normalize_candidate(
        RadarCandidate(
            title=" Agent  release ",
            url="HTTPS://Example.COM/a/?utm_source=x&keep=1#part",
            snippet="  useful   text ",
        )
    )
    assert normalized.title == "Agent release"
    assert normalized.canonical_url == "https://example.com/a?keep=1"
    assert normalized.snippet == "useful text"


def test_normalize_candidate_rejects_non_http() -> None:
    with pytest.raises(ValueError):
        normalize_candidate(RadarCandidate(title="x", url="file:///tmp/x"))


def test_score_candidate_has_three_dimensions_and_reason() -> None:
    normalized = normalize_candidate(
        RadarCandidate(
            title="New LLM agent",
            url="https://example.com/a",
            snippet="RAG and machine learning",
            published_at=datetime.now(timezone.utc) - timedelta(days=1),
            tags=("ai",),
        )
    )
    score = score_candidate(normalized, source_type="github")
    assert 0 <= score.relevance <= 1
    assert score.timeliness == 1
    assert score.source_quality == 0.85
    assert score.version == "1.0"
    assert "仅用于排序，不自动发布" in score.reason
    assert len(score.reason) <= 500


def test_score_old_candidate_is_not_auto_rejected() -> None:
    normalized = normalize_candidate(
        RadarCandidate(
            title="Old systems paper",
            url="https://example.com/old",
            published_at=datetime.now(timezone.utc) - timedelta(days=365),
        )
    )
    score = score_candidate(normalized, source_type="arxiv")
    assert score.timeliness == 0.2
    assert score.source_quality == 0.9


async def test_rss_fetcher_calls_safe_fetch_and_parses_item() -> None:
    calls: list[str] = []

    async def fake_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        calls.append(url)
        return _doc()

    items = await fetch_rss_candidates(
        {"feedUrl": "https://feed.example/rss", "maxResults": 10},
        fetcher=fake_fetch,
    )
    assert calls == ["https://feed.example/rss"]
    assert len(items) == 1
    assert items[0].title == "Agent release"
    assert items[0].content_origin == "rss"


async def test_rss_fetcher_propagates_safe_fetch_rejection() -> None:
    async def blocked(url: str, **kwargs: Any) -> FetchedDocument:
        raise SafeFetchError("URL_FETCH_BLOCKED", "blocked", host="internal.example")

    with pytest.raises(SafeFetchError, match="blocked"):
        await fetch_rss_candidates({"feedUrl": "http://internal.example/rss"}, fetcher=blocked)


async def test_rss_source_private_dns_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """Calling path protection: configured RSS always reaches safe_fetch SSRF checks."""
    from ai_engine.radar import rss_fetcher

    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 0))
    ])
    with pytest.raises(SafeFetchError) as exc_info:
        await rss_fetcher.fetch_rss_candidates({"feedUrl": "http://private.test/rss"})
    assert exc_info.value.code == "URL_FETCH_BLOCKED"


async def test_rss_source_loopback_dns_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    from ai_engine.radar import rss_fetcher

    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))
    ])
    with pytest.raises(SafeFetchError) as exc_info:
        await rss_fetcher.fetch_rss_candidates({"feedUrl": "http://loopback.test/rss"})
    assert exc_info.value.code == "URL_FETCH_BLOCKED"


async def test_github_repository_candidate() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "api.github.com"
        return httpx.Response(
            200,
            json={
                "full_name": "acme/agent",
                "html_url": "https://github.com/acme/agent",
                "description": "AI agent",
                "stargazers_count": 42,
                "pushed_at": "2026-07-22T00:00:00Z",
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await fetch_github({"repos": ["acme/agent"], "type": "stars"}, client=client)
    assert len(items) == 1
    assert items[0].url == "https://github.com/acme/agent"
    assert "42" in items[0].snippet


async def test_github_release_candidates() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[{
                "name": "v1.0",
                "html_url": "https://github.com/acme/agent/releases/tag/v1.0",
                "body": "First release",
                "published_at": "2026-07-22T00:00:00Z",
            }],
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await fetch_github({"repos": ["acme/agent"], "type": "releases"}, client=client)
    assert items[0].title == "acme/agent · v1.0"
    assert items[0].tags == ("github", "release")


async def test_github_rejects_invalid_repo_config() -> None:
    with pytest.raises(ValueError, match="owner/name"):
        await fetch_github({"repos": ["invalid"], "type": "stars"})


async def test_arxiv_fetcher_maps_existing_ingestion(monkeypatch: pytest.MonkeyPatch) -> None:
    from ai_engine.radar import arxiv_fetcher

    async def fake_arxiv(**kwargs: Any) -> list[dict[str, Any]]:
        assert kwargs["categories"] == ["cs.AI"]
        return [{
            "title": "Paper",
            "url": "https://arxiv.org/abs/2607.12345",
            "snippet": "Abstract",
            "published_at": "2026-07-22T00:00:00Z",
            "tags": ["arxiv"],
        }]

    monkeypatch.setattr(arxiv_fetcher, "fetch_arxiv", fake_arxiv)
    items = await fetch_arxiv_candidates({"categories": ["cs.AI"], "maxResults": 1})
    assert items[0].url.endswith("2607.12345")
    assert items[0].source_quality_hint == 0.9


async def test_source_manager_dispatches_fetcher() -> None:
    source = RadarSource("source-1", "GitHub", "github", {})

    async def handler(config: dict[str, Any]) -> list[RadarCandidate]:
        return [RadarCandidate(title="x", url="https://example.com/x")]

    items = await fetch_source(source, fetchers={"github": handler})
    assert items[0].title == "x"


async def test_source_manager_rejects_missing_handler() -> None:
    source = RadarSource("source-1", "RSS", "rss", {})
    with pytest.raises((ValueError, KeyError)):
        await fetch_source(source, fetchers={})
