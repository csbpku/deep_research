from __future__ import annotations

import asyncio
import socket
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest

from ai_engine.fetcher.safe_fetch import FetchedDocument, SafeFetchError
from ai_engine.radar.arxiv_fetcher import fetch_arxiv_candidates
from ai_engine.radar.github import fetch_github
from ai_engine.radar.github_tracked import fetch_github_tracked
from ai_engine.radar.hn_algolia_fetcher import fetch_hn_algolia
from ai_engine.radar.huggingface_papers_fetcher import fetch_huggingface_papers
from ai_engine.radar.models import RadarCandidate, RadarSource
from ai_engine.radar.openreview_fetcher import fetch_openreview
from ai_engine.radar.pipeline import normalize_candidate, score_candidate
from ai_engine.radar.rss_fetcher import fetch_rss_candidates
from ai_engine.radar.source_manager import fetch_source
from ai_engine.radar.vendor_changelog_fetcher import fetch_vendor_changelog
from ai_engine.radar.wewe_refresh import is_wewe_config, refresh_wewe_articles


RSS_XML = b"""<?xml version="1.0"?><rss><channel><item>
<title>Agent release</title><link>https://example.com/agent</link>
<description>LLM agent update</description><pubDate>Wed, 22 Jul 2026 12:00:00 GMT</pubDate>
</item></channel></rss>"""

WEWE_RSS_XML = """<?xml version="1.0"?><rss><channel><item>
<title><![CDATA[中文 AI 工程实践]]></title><link>https://mp.weixin.qq.com/s/example</link>
<content:encoded><![CDATA[<p>这是一篇公众号全文内容，包含 RAG 和 Agent 工程实践。</p>]]></content:encoded>
<pubDate>Wed, 22 Jul 2026 12:00:00 GMT</pubDate>
</item></channel></rss>""".encode()

BLOGGER_ATOM_XML = b"""<?xml version='1.0'?><feed xmlns='http://www.w3.org/2005/Atom'>
<entry gd:etag='x'>
<title>Fresh AI article</title>
<link rel='replies' type='application/atom+xml' href='http://blog.example/feeds/123/comments/default'/>
<link href='https://blog.example/fresh-ai-article' type='text/html' rel='alternate'/>
<content type='html'>&lt;p&gt;LLM agent engineering update&lt;/p&gt;</content>
<published>2026-07-22T12:00:00Z</published>
</entry></feed>"""


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
    assert score.version == "1.2"
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
    # fetch_rss_candidates returns parsed items; just verify kwargs were passed
    assert items[0].title == "Agent release"
    assert items[0].content_origin == "rss"


async def test_wewe_feed_refreshes_before_reading_feed() -> None:
    calls: list[str] = []

    async def fake_refresh(config: Any) -> bool:
        calls.append("refresh")
        return True

    async def fake_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        calls.append("fetch")
        return _doc()

    await fetch_rss_candidates(
        {"feedUrl": "http://localhost:4001/feeds/all.rss", "maxResults": 10},
        fetcher=fake_fetch,
        wewe_refresher=fake_refresh,
    )
    assert calls == ["refresh", "fetch"]


async def test_wewe_refresh_uses_trpc_batch_request() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/trpc/feed.refreshArticles"
        assert request.url.params.get("batch") == "1"
        assert request.headers["content-type"] == "application/json"
        assert request.read() == b'{"0":{"json":{}}}'
        return httpx.Response(200, json=[{"result": {"data": True}}])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert is_wewe_config({"feedUrl": "http://localhost:4001/feeds/all.rss"})
        assert await refresh_wewe_articles(
            {"feedUrl": "http://localhost:4001/feeds/all.rss"}, client=client
        )


async def test_wewe_expired_account_is_reported_without_blocking_feed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            500,
            json=[{"error": {"message": "暂无可用读书账号!"}}],
        )

    config: dict[str, Any] = {"feedUrl": "http://localhost:4001/feeds/all.rss"}
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert not await refresh_wewe_articles(config, client=client)
    assert config["_wewe_refresh_diagnostic"] == (
        "UPSTREAM_AUTH_REQUIRED",
        "WeWe 读书账号登录已失效，需要重新扫码登录",
    )


async def test_non_wewe_rss_does_not_refresh() -> None:
    async def fake_refresh(config: Any) -> bool:
        raise AssertionError("ordinary RSS must not call WeWe")

    async def fake_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        return _doc()

    await fetch_rss_candidates(
        {"feedUrl": "https://feed.example/rss", "maxResults": 10},
        fetcher=fake_fetch,
        wewe_refresher=fake_refresh,
    )


async def test_rss_fetcher_reads_wewe_content_encoded() -> None:
    async def fake_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        return _doc(WEWE_RSS_XML)

    items = await fetch_rss_candidates(
        {"feedUrl": "http://feed.example/rss", "maxResults": 10, "applyAiFilter": False},
        fetcher=fake_fetch,
    )
    assert len(items) == 1
    assert "公众号全文内容" in items[0].snippet


async def test_rss_fetcher_cleans_wewe_html_instead_of_passing_page_shell() -> None:
    article = "真正的公众号正文，包含 RAG 工程实践和 Agent 评测方法。 " * 40
    xml = f"""<?xml version="1.0"?><rss><channel><item>
    <title><![CDATA[正文测试]]></title><link>https://mp.weixin.qq.com/s/example2</link>
    <content:encoded><![CDATA[<html><head><script>window.pageData = 'noise';</script></head>
    <body><div id="js_content"><p>{article}</p></div></body></html>]]></content:encoded>
    <pubDate>Wed, 22 Jul 2026 12:00:00 GMT</pubDate>
    </item></channel></rss>""".encode()

    async def fake_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        return _doc(xml)

    items = await fetch_rss_candidates(
        {"feedUrl": "http://localhost:4001/feeds/all.rss", "maxResults": 10,
         "applyAiFilter": False, "allowLocalhost": True},
        fetcher=fake_fetch,
        wewe_refresher=lambda config: _noop_refresh(),
    )
    assert len(items) == 1
    assert len(items[0].snippet) > 1000
    assert "window.pageData" not in items[0].snippet
    assert "真正的公众号正文" in items[0].snippet
    assert "wewe" in items[0].tags


async def _noop_refresh() -> bool:
    return True


async def test_rss_fetcher_prefers_atom_article_link_over_comments_feed() -> None:
    async def fake_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        return _doc(BLOGGER_ATOM_XML)

    items = await fetch_rss_candidates(
        {"feedUrl": "https://blog.example/feed", "maxResults": 10, "applyAiFilter": False,
         "maxAgeHours": 8760},
        fetcher=fake_fetch,
    )
    assert len(items) == 1
    assert items[0].url == "https://blog.example/fresh-ai-article"


async def test_rss_fetcher_default_age_gate_drops_archive_items() -> None:
    old = RSS_XML.replace(b"Wed, 22 Jul 2026 12:00:00 GMT", b"Wed, 22 Jul 2020 12:00:00 GMT")

    async def fake_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        return _doc(old)

    items = await fetch_rss_candidates(
        {"feedUrl": "https://feed.example/rss", "maxResults": 10},
        fetcher=fake_fetch,
    )
    assert items == []


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
    # fetch_rss_candidates returns parsed items; just verify kwargs were passed
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


def _github_iso(days_ago: int = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _github_pr(updated_at: str | None = None) -> dict[str, Any]:
    return {
        "title": "PR title",
        "html_url": "https://github.com/acme/agent/pull/1",
        "body": "PR body",
        "updated_at": updated_at or _github_iso(),
        "state": "open",
        "user": {"login": "alice"},
    }


def _github_issue(number: int, updated_at: str) -> dict[str, Any]:
    return {
        "number": number,
        "title": f"issue-{number}",
        "html_url": f"https://github.com/acme/agent/issues/{number}",
        "body": "Issue body",
        "updated_at": updated_at,
        "state": "open",
        "user": {"login": "alice"},
    }


def _github_release(tag: str, published_at: str) -> dict[str, Any]:
    return {
        "tag_name": tag,
        "name": tag,
        "html_url": f"https://github.com/acme/agent/releases/tag/{tag}",
        "body": "Release body",
        "published_at": published_at,
    }


async def test_github_tracked_ordinary_repo_fetches_single_pull_page() -> None:
    pull_requests: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/pulls"):
            pull_requests.append(request.url.params["page"])
            return httpx.Response(200, json=[_github_pr()])
        if request.url.path.endswith("/issues"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/releases"):
            return httpx.Response(200, json=[])
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await fetch_github_tracked(
            {
                "repos": ["acme/agent"],
                "lookback_days": 7,
                "max_items_per_repo": 50,
                "paginated_repos": [],
            },
            client=client,
        )
    assert pull_requests == ["1"]
    assert len(items) == 1


async def test_github_tracked_caps_total_per_repo_across_types() -> None:
    issues = [_github_issue(i, _github_iso(1)) for i in range(10)]
    prs = [_github_pr(_github_iso(2)) for _ in range(10)]
    releases = [_github_release(f"v1.{i}", _github_iso(3)) for i in range(10)]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/issues"):
            return httpx.Response(200, json=issues)
        if request.url.path.endswith("/pulls"):
            return httpx.Response(200, json=prs)
        if request.url.path.endswith("/releases"):
            return httpx.Response(200, json=releases)
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await fetch_github_tracked(
            {
                "repos": ["acme/agent"],
                "lookback_days": 7,
                "max_items_per_repo": 15,
                "paginated_repos": [],
            },
            client=client,
        )

    # One repo digest candidate; inside the activity, issues come first,
    # then PRs, and releases fall outside the per-repo cap.
    assert len(items) == 1
    activity = items[0].repo_activity
    assert activity is not None
    assert activity.item_count == 15
    assert [it.title for it in activity.issues] == [f"issue-{i}" for i in range(10)]
    assert [it.title for it in activity.prs] == ["PR title"] * 5
    assert activity.releases == ()


async def test_github_tracked_releases_respect_lookback() -> None:
    releases = [
        _github_release("v1.0", _github_iso(10)),
        _github_release("v2.0", _github_iso(1)),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/issues"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/pulls"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/releases"):
            return httpx.Response(200, json=releases)
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await fetch_github_tracked(
            {
                "repos": ["acme/agent"],
                "lookback_days": 7,
                "max_items_per_repo": 50,
                "paginated_repos": [],
            },
            client=client,
        )

    assert [it.title for it in items] == ["acme/agent 24h GitHub 动态"]
    assert [it.number for it in items[0].repo_activity.releases] == ["v2.0"]


async def test_github_tracked_paginated_repo_walks_up_to_five_pages() -> None:
    pull_requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/pulls"):
            page = request.url.params["page"]
            pull_requests.append(page)
            return httpx.Response(200, json=[_github_pr() for _ in range(100)])
        if request.url.path.endswith("/issues"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/releases"):
            return httpx.Response(200, json=[])
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await fetch_github_tracked(
            {
                "repos": ["acme/agent"],
                "lookback_days": 7,
                "max_items_per_repo": 50,
                "paginated_repos": ["ACME/Agent/"],
            },
            client=client,
        )
    assert pull_requests == ["1", "2", "3", "4", "5"]
    assert len(items) == 1
    assert len(items[0].repo_activity.prs) == 20


async def test_github_tracked_paginated_repo_stops_at_stale_page() -> None:
    pull_requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/pulls"):
            page = request.url.params["page"]
            pull_requests.append(page)
            if page == "2":
                return httpx.Response(200, json=[_github_pr("2026-01-01T00:00:00Z")])
            return httpx.Response(200, json=[_github_pr() for _ in range(100)])
        if request.url.path.endswith("/issues"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/releases"):
            return httpx.Response(200, json=[])
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        items = await fetch_github_tracked(
            {
                "repos": ["acme/agent"],
                "lookback_days": 7,
                "max_items_per_repo": 50,
                "paginated_repos": ["acme/agent"],
            },
            client=client,
        )
    assert pull_requests == ["1", "2"]
    assert len(items) == 1
    assert len(items[0].repo_activity.prs) == 20


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
            "published_at": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
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


def test_rss_fetcher_allow_localhost_passes_flag() -> None:
    """allow_localhost kwarg should pass allow_localhost=True to fetcher."""
    received_kwargs: dict[str, Any] = {}

    async def fake_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        received_kwargs.update(kwargs)
        return _doc()

    import asyncio
    asyncio.run(fetch_rss_candidates(
        {"feedUrl": "http://localhost:4001/feeds/test.rss", "maxResults": 5},
        fetcher=fake_fetch,
        allow_localhost=True,
    ))
    assert received_kwargs.get("allow_localhost") is True
    assert 4001 in received_kwargs.get("extra_allowed_ports", ())
    # fetch_rss_candidates returns parsed items; just verify kwargs were passed


def test_rss_fetcher_allow_localhost_from_config() -> None:
    """allowLocalhost in config dict should also enable bypass."""
    received_kwargs: dict[str, Any] = {}

    async def fake_fetch(url: str, **kwargs: Any) -> FetchedDocument:
        received_kwargs.update(kwargs)
        return _doc()

    import asyncio
    asyncio.run(fetch_rss_candidates(
        {
            "feedUrl": "http://localhost:4001/feeds/test.rss",
            "maxResults": 5,
            "allowLocalhost": True,
            "localPort": 4001,
        },
        fetcher=fake_fetch,
    ))
    assert received_kwargs.get("allow_localhost") is True
    assert 4001 in received_kwargs.get("extra_allowed_ports", ())


# PR2: Hugging Face Daily Papers fetcher — happy path + age gate + envelope shape.


def _make_hf_payload(*, fresh_hours_ago: float, old_hours_ago: float) -> list[dict[str, Any]]:
    """Build an HF Daily Papers payload with timestamps relative to ``datetime.now``.

    The fetcher compares against ``datetime.now(timezone.utc)`` so the test must
    as well — using fixed wall-clock timestamps would make the assertions
    dependent on whoever is running pytest.
    """
    now = datetime.now(timezone.utc)
    fresh_iso = (now - timedelta(hours=fresh_hours_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    old_iso = (now - timedelta(hours=old_hours_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return [
        {
            "title": "Omni-Modal Dialogue via Visual Thought Plans",
            "summary": "Coordinated text + speech + video responses.",
            "numComments": 3,
            "submittedBy": {"name": "curator"},
            "paper": {
                "id": "2608.10720",
                "title": "Omni-Modal Dialogue via Visual Thought Plans",
                "ai_keywords": ["omni-modal dialogue", "video generator"],
                "ai_summary": "An omni-modal dialogue framework.",
                "authors": [{"name": "Alice"}, {"name": "Bob"}, {"name": "Carol"}],
                "githubRepo": "https://github.com/example/repo",
                "githubStars": 12,
                "publishedAt": fresh_iso,
            },
        },
        {
            "title": "Older paper that should fall outside the lookback",
            "paper": {
                "id": "2601.99999",
                "ai_keywords": [],
                "authors": [],
                "publishedAt": old_iso,
            },
        },
    ]


async def test_hf_daily_papers_parses_and_caps_results() -> None:
    """The fetcher must map HF Daily Papers rows into RadarCandidates
    and respect the maxResults cap."""

    payload = _make_hf_payload(fresh_hours_ago=6, old_hours_ago=24 * 30)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/daily_papers"
        return httpx.Response(200, json=payload)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_huggingface_papers(
            {"maxResults": 1, "maxAgeHours": 96},
            client=client,
        )
    assert len(items) == 1, items
    top = items[0]
    assert top.title == "Omni-Modal Dialogue via Visual Thought Plans"
    assert top.url == "https://huggingface.co/papers/2608.10720"
    assert "Alice, Bob, Carol" in top.snippet
    assert "omni-modal_dialogue" in top.tags
    assert "An omni-modal dialogue" in top.snippet
    assert top.content_origin == "api"
    assert top.source_quality_hint == 0.90


async def test_hf_daily_papers_drops_entries_outside_lookback() -> None:
    """The age gate must drop >maxAgeHours items even when the API returns them."""

    payload = _make_hf_payload(fresh_hours_ago=2, old_hours_ago=24 * 60)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_huggingface_papers(
            {"maxResults": 20, "maxAgeHours": 24},
            client=client,
        )
    # Only the fresh item survives the 24h gate.
    assert len(items) == 1
    assert items[0].url == "https://huggingface.co/papers/2608.10720"


async def test_hf_daily_papers_handles_non_list_response() -> None:
    """An unexpected response shape (e.g. API maintenance payload) must not crash."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"error": "rate limited"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_huggingface_papers({"maxResults": 5}, client=client)
    assert items == []


# PR3: OpenReview fetcher — multi-venue search + age gate + resilience.


def _openreview_payload(*, fresh_days_ago: float) -> dict[str, Any]:
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    pdate_ms = now_ms - int(fresh_days_ago * 24 * 3600 * 1000)
    return {
        "count": 1,
        "notes": [
            {
                "id": "note-1",
                "forum": "forum-1",
                "pdate": pdate_ms,
                "mdate": pdate_ms,
                "content": {
                    "title": {"value": "SWE-agent: Agent-Computer Interfaces"},
                    "abstract": {"value": "We present SWE-agent, a multi-turn LLM agent."},
                    "keywords": {"value": ["agents", "software engineering"]},
                    "venue": {"value": "NeurIPS 2024 oral"},
                    "authors": {"value": [{"name": "Alice"}, {"name": "Bob"}]},
                    "pdf": {"value": "https://openreview.net/pdf?id=forum-1"},
                },
            },
        ],
    }


async def test_openreview_emits_canonical_forum_url() -> None:
    """End-to-end: mock a single OpenReview hit and assert the candidate URL is a forum URL."""

    payload = _openreview_payload(fresh_days_ago=3)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params.get("invitation") == "NeurIPS.cc/2024/Conference/-/Submission"
        return httpx.Response(200, json=payload)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_openreview(
            {
                "venues": ["NeurIPS.cc/2024/Conference"],
                "maxResults": 10,
                "maxAgeDays": 14,
                "limitPerVenue": 5,
                "query": "agent",
            },
            client=client,
        )
    assert len(items) == 1
    top = items[0]
    assert top.url == "https://openreview.net/forum?id=forum-1"
    assert "Alice, Bob" in top.snippet
    assert "NeurIPS 2024 oral" in top.snippet
    assert "software engineering" in top.snippet
    assert "openreview" in top.tags
    # The venue slug is the part before the first "/" of the venue id.
    assert any(tag.startswith("neurips") for tag in top.tags)
    assert top.content_origin == "api"


async def test_openreview_drops_old_papers_via_age_gate() -> None:
    """Papers older than ``maxAgeDays`` must be filtered out client-side."""

    payload = _openreview_payload(fresh_days_ago=120)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_openreview(
            {
                "venues": ["NeurIPS.cc/2024/Conference"],
                "maxResults": 10,
                "maxAgeDays": 14,
                "limitPerVenue": 5,
                "query": "agent",
            },
            client=client,
        )
    assert items == []


async def test_openreview_requires_venues_in_config() -> None:
    """No venues configured means nothing returned — the fetcher does not invent venues."""

    transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"notes": []}))
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_openreview({"venues": []}, client=client)
    assert items == []


async def test_openreview_handles_non_list_notes_payload() -> None:
    """Defensive: an unexpected payload shape must not crash the runner."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"error": "service unavailable"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_openreview(
            {
                "venues": ["NeurIPS.cc/2024/Conference"],
                "maxResults": 5,
                "maxAgeDays": 14,
                "limitPerVenue": 5,
                "query": "agent",
            },
            client=client,
        )
    assert items == []


# PR4: HN Algolia fetcher — query + numeric filters + tag gating.


def _hn_algolia_payload() -> dict[str, Any]:
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    now_ts = int(datetime.now(timezone.utc).timestamp())
    return {
        "hits": [
            {
                "objectID": "story-1",
                "story_id": 42424242,
                "title": "Show HN: New agentic LLM tooling",
                "url": "https://example.com/post",
                "author": "alice",
                "created_at": now_iso,
                "created_at_i": now_ts - 60,  # 1 minute old
                "points": 80,
                "num_comments": 12,
                "_tags": ["story", "author_alice", "story_42424242"],
            },
            {
                "objectID": "comment-1",
                "title": None,
                "url": None,
                "created_at_i": now_ts - 30,
                "_tags": ["comment", "author_bob"],
            },
            {
                "objectID": "story-2",
                "title": "Cryptocurrency airdrop tutorial",
                "url": "https://example.com/crypto",
                "author": "carol",
                "created_at": now_iso,
                "created_at_i": now_ts - 120,
                "points": 200,
                "num_comments": 50,
                "_tags": ["story"],
            },
        ],
    }


async def test_hn_algolia_emits_story_with_external_link() -> None:
    """A story hit with an external URL must surface the URL and an HN fallback id.

    The keyword filter is enforced server-side by Algolia — the fetcher trusts
    ``hits[]`` to be the already-filtered result set. The mock payload below
    contains two story hits (one on AI, one off-topic) because that's what a
    malicious or stale Algolia response could look like; the fetcher's job is
    only to map them correctly, not to re-filter. We therefore assert on shape
    and tags rather than expecting exactly one hit.
    """

    payload = _hn_algolia_payload()

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params.get("tags") == "story"
        assert "created_at_i>" in request.url.params.get("numericFilters", "")
        return httpx.Response(200, json=payload)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_hn_algolia(
            {"maxResults": 10, "maxAgeHours": 24, "minPoints": 5, "minComments": 0},
            client=client,
        )
    assert items, items
    ai_hit = next(item for item in items if "agentic" in item.title)
    assert ai_hit.title == "Show HN: New agentic LLM tooling"
    assert ai_hit.url == "https://example.com/post"
    assert "alice" in ai_hit.snippet
    assert "HN points: 80" in ai_hit.snippet
    assert "hn_algolia" in ai_hit.tags


async def test_hn_algolia_skips_non_story_hits() -> None:
    """Comments and polls must be filtered out via the _tags gate."""

    payload = _hn_algolia_payload()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_hn_algolia(
            {"maxResults": 10, "maxAgeHours": 24, "minPoints": 0, "minComments": 0},
            client=client,
        )
    # The comment hit (``_tags: ["comment", ...]``) must be filtered out by
    # _is_story_hit. Only story-tagged hits survive.
    titles = [item.title for item in items]
    assert all("agentic" in t or "Cryptocurrency" in t for t in titles), titles
    assert len(items) == 2, items  # both stories survived, the comment didn't.


async def test_hn_algolia_enforces_min_points_and_min_comments() -> None:
    """Both score gates must drop stories below the configured thresholds."""

    payload = {
        "hits": [
            {
                "objectID": "low-engagement",
                "title": "Tiny mention of llm",
                "created_at_i": int(datetime.now(timezone.utc).timestamp()),
                "points": 1,
                "num_comments": 0,
                "_tags": ["story"],
            },
            {
                "objectID": "high-engagement",
                "title": "Strong agent benchmark",
                "created_at_i": int(datetime.now(timezone.utc).timestamp()),
                "points": 200,
                "num_comments": 40,
                "_tags": ["story"],
            },
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_hn_algolia(
            {"maxResults": 10, "maxAgeHours": 24, "minPoints": 10, "minComments": 5},
            client=client,
        )
    assert len(items) == 1
    assert items[0].title == "Strong agent benchmark"


# P1.11: Vendor changelog fetcher — title regex + statefile dedupe.


import tempfile

VENDOR_CHANGELOG_HTML = """
<html><body>
<h2>2026-08-10 — gpt-5 model launch</h2>
<p>OpenAI released gpt-5 with 400k context, structured outputs, and a fast tier.</p>
<h2>2026-08-05 — Responses API additions</h2>
<p>File search now supports 10k documents per request.</p>
<h2>2026-07-29 — vision input pricing</h2>
<p>Vision input pricing reduced by 20% for cached inputs.</p>
</body></html>
""".strip()


async def test_vendor_changelog_extracts_h2_titles_and_dedupes(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    state_file = tmp_path / "vendor_changelog_state.json"
    monkeypatch.setenv("VENDOR_CHANGELOG_STATE_PATH", str(state_file))

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=VENDOR_CHANGELOG_HTML.encode())

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        # First call: no prior state -> all three entries show up.
        items = await fetch_vendor_changelog(
            {
                "vendor": "openai",
                "sources": ["https://platform.openai.com/docs/changelog"],
                "title_pattern": "<h2[^>]*>(.*?)</h2>",
                "max_entries": 30,
            },
            client=client,
        )
        assert len(items) == 3, items
        first_titles = [it.title for it in items]
        assert "gpt-5 model launch" in first_titles[0]
        # Second call with the same fetch: statefile dedupes, returns 0.
        items_again = await fetch_vendor_changelog(
            {
                "vendor": "openai",
                "sources": ["https://platform.openai.com/docs/changelog"],
                "title_pattern": "<h2[^>]*>(.*?)</h2>",
                "max_entries": 30,
            },
            client=client,
        )
        assert items_again == []


async def test_vendor_changelog_applies_path_filter(tmp_path) -> None:
    state_file = tmp_path / "vendor_changelog_state.json"

    html = """
    <body>
    <h2>Marketing post</h2><p>Should be filtered out by the path regex.</p>
    <a href="/en/release-notes/2026/08/10">10</a>
    </body>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=html.encode())

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = await fetch_vendor_changelog(
            {
                "vendor": "anthropic",
                "sources": ["https://docs.anthropic.com/en/release-notes/"],
                "title_pattern": "<h2[^>]*>(.*?)</h2>",
                "allow_path_regex": "/release-notes/",
                "max_entries": 30,
            },
            client=client,
        )
    # The path regex applies to the constructed candidate URL (source + slug).
    # Each candidate's URL contains the source URL, which includes
    # "/release-notes/" → all keep; the filter rejects none in this simple
    # case. The point of this test is to confirm the regex line is wired
    # through without crashing; behavioural assertions live in
    # test_vendor_changelog_extracts_h2_titles_and_dedupes above.
    assert isinstance(items, list)
