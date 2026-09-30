from __future__ import annotations

import base64
import json
from contextlib import asynccontextmanager
from typing import Any

from ai_engine.fetcher.safe_fetch import FetchedDocument
from ai_engine.radar.scoring_input import transient_scoring_input


class _Pool:
    def __init__(self, excerpt: str | None = None) -> None:
        self.excerpt = excerpt
        self.queries: list[tuple[str, tuple[Any, ...]]] = []

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self

    async def execute(self, sql: str, params: tuple[Any, ...]):  # type: ignore[no-untyped-def]
        self.queries.append((sql, params))
        return self

    async def fetchone(self):  # type: ignore[no-untyped-def]
        return {"body": self.excerpt} if self.excerpt is not None else None


def _row(**overrides: Any) -> dict[str, Any]:
    return {
        "source": "daily",
        "tags": ["external_reading"],
        "sourceType": "arxiv",
        "url": "https://arxiv.org/abs/2609.00001",
        "canonicalUrl": "https://arxiv.org/abs/2609.00001",
        "syncRunId": "run-1",
        **overrides,
    }


async def test_uses_existing_source_excerpt_without_network_or_new_writes() -> None:
    excerpt = "A technical paper describes its method, experiments and limitations. " * 20
    pool = _Pool(excerpt)

    async def no_fetch(*args: Any, **kwargs: Any) -> FetchedDocument:
        raise AssertionError("an adequate excerpt must not be fetched again")

    assert await transient_scoring_input(pool, _row(), fetcher=no_fetch) == (
        excerpt.strip()[:2_000], "source_excerpt",
    )
    assert len(pool.queries) == 1
    sql, params = pool.queries[0]
    assert "PENDING_SCORE" in sql
    assert params == ("run-1", "https://arxiv.org/abs/2609.00001")
    assert sql.startswith("SELECT")


async def test_short_excerpt_uses_bounded_in_memory_source_read() -> None:
    pool = _Pool("A technically detailed research abstract describes benchmarks. " * 9)
    seen: list[dict[str, Any]] = []
    html = (
        '<h1 class="title mathjax"><span>Title:</span> An arXiv study</h1>'
        '<blockquote class="abstract">'
        + "A peer-reviewed research result discusses benchmarks and implementation. " * 15
        + "</blockquote>"
        + "<aside>Navigation and citation tools " * 100 + "</aside>"
    )

    async def fetch(url: str, **kwargs: Any) -> FetchedDocument:
        seen.append({"url": url, **kwargs})
        return FetchedDocument(
            url=url, final_ip="8.8.8.8", status=200,
            headers={}, content=html.encode(), content_type="text/html",
            elapsed_ms=12,
        )

    result = await transient_scoring_input(pool, _row(), fetcher=fetch)
    assert result is not None
    assert result[1] == "source_abstract"
    assert "benchmarks and implementation" in result[0]
    assert "# arXiv:2609.00001" in result[0]
    assert "# Title:An arXiv study" in result[0]
    assert "Navigation and citation tools" not in result[0]
    assert seen == [{
        "url": "https://arxiv.org/abs/2609.00001",
        "max_bytes": 256_000, "timeout": 10.0, "max_redirects": 2,
        "allowed_hosts": ("arxiv.org", "github.com"),
    }]
    assert len(pool.queries) == 1


async def test_limited_excerpt_falls_back_when_source_fetch_fails() -> None:
    excerpt = "An arXiv abstract describes the approach and its evaluation. " * 9
    pool = _Pool(excerpt)

    async def unavailable(*args: Any, **kwargs: Any) -> FetchedDocument:
        raise RuntimeError("temporary upstream failure")

    assert await transient_scoring_input(pool, _row(), fetcher=unavailable) == (
        excerpt.strip(), "source_excerpt",
    )
    assert len(pool.queries) == 1


async def test_rejects_untrusted_rows_and_non_https_links_without_fetch() -> None:
    pool = _Pool()

    async def no_fetch(*args: Any, **kwargs: Any) -> FetchedDocument:
        raise AssertionError("not an approved source link")

    for row in (
        _row(source="user"),
        _row(tags=["content_pending"]),
        _row(url="https://arxiv.org.attacker.example/abs/1"),
        _row(url="http://arxiv.org/abs/1"),
        _row(sourceType="hackernews"),
    ):
        assert await transient_scoring_input(pool, row, fetcher=no_fetch) is None
    assert all(sql.startswith("SELECT") for sql, _ in pool.queries)


async def test_archived_daily_row_never_uses_legacy_diagnostic_excerpt() -> None:
    pool = _Pool("A generated guess about a paper. " * 30)

    async def fetch(url: str, **kwargs: Any) -> FetchedDocument:
        text = '<h1 class="title">Title: An arXiv study</h1><blockquote class="abstract">' + (
            "The study tests a concrete method and reports an evaluation. " * 25
        ) + "</blockquote>"
        return FetchedDocument(
            url=url, final_ip="8.8.8.8", status=200, headers={},
            content=text.encode(), content_type="text/html", elapsed_ms=12,
        )

    result = await transient_scoring_input(
        pool, _row(status="archived", tags=["legacy"]), fetcher=fetch,
    )
    assert result is not None and result[1] == "source_abstract"
    assert "concrete method" in result[0]
    assert not pool.queries


async def test_arxiv_missing_abstract_never_scores_page_navigation() -> None:
    async def fetch(url: str, **kwargs: Any) -> FetchedDocument:
        html = (
            '<h1 class="title">Title: A study</h1>'
            + "<nav>Bibliographic and Citation Tools</nav>" * 100
        )
        return FetchedDocument(
            url=url, final_ip="8.8.8.8", status=200, headers={},
            content=html.encode(), content_type="text/html", elapsed_ms=12,
        )

    assert await transient_scoring_input(_Pool(), _row(), fetcher=fetch) is None


async def test_github_repo_uses_bounded_api_readme_instead_of_large_html() -> None:
    pool = _Pool()
    seen: list[tuple[str, dict[str, Any]]] = []
    readme = "# OpenShell\nTechnical architecture and access-control mechanisms. " * 25

    async def fetch(url: str, **kwargs: Any) -> FetchedDocument:
        seen.append((url, kwargs))
        payload = json.dumps({
            "encoding": "base64",
            "content": base64.b64encode(readme.encode()).decode(),
        })
        return FetchedDocument(
            url=url, final_ip="8.8.8.8", status=200, headers={},
            content=payload.encode(), content_type="application/json", elapsed_ms=12,
        )

    result = await transient_scoring_input(
        pool, _row(
            sourceType="github", syncRunId=None, tags=["external_reading"],
            url="https://github.com/NVIDIA/OpenShell",
        ), fetcher=fetch,
    )
    assert result == (readme[:18_000], "transient_source")
    assert seen == [(
        "https://api.github.com/repos/NVIDIA/OpenShell/readme",
        {
            "max_bytes": 256_000, "timeout": 10.0, "max_redirects": 0,
            "allowed_hosts": ("api.github.com",),
        },
    )]


async def test_devto_uses_bounded_page_budget_for_large_html() -> None:
    seen: list[dict[str, Any]] = []

    async def fetch(url: str, **kwargs: Any) -> FetchedDocument:
        seen.append(kwargs)
        html = "<article>" + (
            "The author compares agent tool use and runtime isolation. " * 30
        ) + "</article>"
        return FetchedDocument(
            url=url, final_ip="8.8.8.8", status=200, headers={},
            content=html.encode(), content_type="text/html", elapsed_ms=12,
        )

    await transient_scoring_input(
        _Pool(), _row(
            sourceType="devto", syncRunId=None,
            url="https://dev.to/example/technical-article",
        ), fetcher=fetch,
    )
    assert seen[0]["max_bytes"] == 512_000
    assert seen[0]["allowed_hosts"] == ("dev.to", "github.com")


async def test_rejects_shell_failure_status_and_cross_domain_result() -> None:
    pool = _Pool("short")

    async def fetch(url: str, **kwargs: Any) -> FetchedDocument:
        return FetchedDocument(
            url=kwargs.get("final_url", url), final_ip="8.8.8.8",
            status=kwargs.get("status", 200), headers={},
            content=("Just a moment, verifying your browser " * 30).encode(),
            content_type="text/html", elapsed_ms=12,
        )

    assert await transient_scoring_input(pool, _row(), fetcher=fetch) is None

    async def wrong_host(url: str, **kwargs: Any) -> FetchedDocument:
        return FetchedDocument(
            url="https://untrusted.example/article", final_ip="8.8.8.8",
            status=200, headers={}, content=b"irrelevant",
            content_type="text/html", elapsed_ms=12,
        )

    assert await transient_scoring_input(pool, _row(), fetcher=wrong_host) is None

    async def failed_status(url: str, **kwargs: Any) -> FetchedDocument:
        return FetchedDocument(
            url=url, final_ip="8.8.8.8", status=404, headers={},
            content=b"Not found " * 100, content_type="text/html", elapsed_ms=12,
        )

    assert await transient_scoring_input(pool, _row(), fetcher=failed_status) is None
    assert all(sql.startswith("SELECT") for sql, _ in pool.queries)
